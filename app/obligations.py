"""责任矩阵：两版条款义务项提取、映射组内配对与变更判定。

设计原则（确定性、可解释、**禁止强行匹配**）：

1. **公开提取规则**：对每侧段落按句切分（``。！？；`` 与换行为句边界），
   以四个情态词锚点「应当 / 必须 / 不得 / 可以」提取义务项
   （“不得不”为固定搭配，不计入“不得”）：
   - **主体**：情态词之前、最近一个句内标点（，、；：）之后的短语；
     若该短语内仍含前一情态词（承前长句），视为无主语；
     同句第二个及以后的情态词若无主语，则**继承同句前一义务项的主体**
     并标记 ``subject_inherited``；仍无主体记为缺失（``None``）；
   - **行为**：情态词之后到下一个情态词或句尾之间的文本；若下一情态词
     之前存在句内标点，则在最后一个句内标点处截断（标点后的短语留给
     下一义务项作主体候选）；
   - **时限**：在行为文本内按公开正则列表首个命中提取
     （提前 N 日、每月 N 日、自……之日起、N 日/周/月/年 内·前·后、
     立即/及时/当场/随时）。
2. **仅在现有段落映射组内配对**：只有 **1 旧 ↔ 1 新** 的对齐记录才进行
   自动配对；拆分 / 合并 / 多对多映射组内一律不强行配对，组内义务项
   全部列为 **待核验** 并展示对侧候选；纯新增 / 纯删除映射组的义务项
   直接判为 **新增 / 移除**；未参与任何映射的段落义务项列为待核验。
3. **配对打分**：``0.5 × 主体相似度 + 0.5 × 行为相似度``（情态词不参与
   打分——情态差异正是要判定的内容）。双方**互为最优候选**且任一侧
   前两名分差大于并列阈值（0.03）才成对；候选并列或竞争未互选时
   列为 **待核验** 并完整展示候选，绝不静默选取。
4. **七态判定**：新增 / 移除 / 加强 / 弱化 / 禁止放宽 / 内容变化 /
   待核验。情态强度公开排序：可以(1) < 应当(2) < 必须(3) < 不得(4，禁止)；
   「不得」降为其他情态专判 **禁止放宽**。同模态时比较时限
   （新增时限→加强、取消时限→弱化、可比较时缩短→加强 / 放宽→弱化、
   不可比较→内容变化）与行为表述（不同→内容变化）；完全一致的配对
   不计入矩阵，仅在汇总中报告“未变化”。

本模块**即时计算、不落库**：映射增删改或重新对齐后，下一次请求自然
按最新映射重算。
"""
from __future__ import annotations

import re

from .aligner import similarity
from .citations import build_structure, int_to_cn, parse_num

# ---------------- 判定类别 ----------------

JUDGMENT_LABEL = {
    "added": "新增",
    "removed": "移除",
    "strengthened": "加强",
    "weakened": "弱化",
    "relaxed": "禁止放宽",
    "changed": "内容变化",
    "review": "待核验",
}

MODALS = ("应当", "必须", "不得", "可以")
MODAL_RANK = {"可以": 1, "应当": 2, "必须": 3, "不得": 4}
MODAL_DESC = {
    "应当": "义务（应当）",
    "必须": "强制义务（必须）",
    "不得": "禁止（不得）",
    "可以": "许可（可以）",
}

# 情态词锚点；“不得不”按固定搭配排除（其义为“只能”，并非禁止）
MODAL_RE = re.compile(r"应当|必须|不得(?!不)|可以")

# 句边界：。！？； 与换行
_SENT_RE = re.compile(r"[^。！？；\n]+[。！？；]?")
# 句内分句标点（主体取最后一个分句）
_CLAUSE_SPLIT_RE = re.compile(r"[，、；：,.;:]")
# 主体短语首尾的连接词（“并、且、以及……”）剥除
_LEAD_CONN_RE = re.compile(r"^(?:并|且|以及|和|与|同时|也|还|则|即)+")
_TAIL_CONN_RE = re.compile(r"(?:并|且|以及|和|与|同时|也|还|则|即)+$")

_NORM_RE = re.compile(r"[\s　，。；：、“”‘’（）()【】《》,.;:\"'?!？！\-—_0-9０-９]")

# 主体首部的结构编号（第X条/章/节、（一）、1. 等）不计入主体
_NUM = r"[0-9０-９零一二两三四五六七八九十百千万]+"
_STRUCT_HEAD_RE = re.compile(
    rf"^(?:第{_NUM}+[条章节](?!之一)|[（(]{_NUM}+[）)]|[0-9０-９]{{1,2}}[\.、)])\s*"
)

# ---------------- 时限公开规则（有序，首个命中生效） ----------------

DEADLINE_RES = [
    re.compile(rf"(?:至少|最多)?提前{_NUM}(?:个)?(?:工作日|日|天)"),
    re.compile(rf"每月{_NUM}日(?:之前|以前|前|以内|内)?"),
    re.compile(rf"自[^，。；、：]{{1,20}}?之日起(?:{_NUM}(?:个)?(?:工作日|日|天|个月|月|年)(?:以内|内))?"),
    re.compile(rf"{_NUM}(?:个)?(?:工作日|日|天|周|星期|个月|月|年)(?:以内|内|之前|以前|前|之后|以后|后)"),
    re.compile(r"立即|及时|当场|随时"),
]
_DL_NUM_UNIT_RE = re.compile(rf"({_NUM})(?:个)?(工作日|日|天|周|星期|个月|月|年)")

# ---------------- 配对公开阈值 ----------------

PAIR_THRESHOLD = 0.55   # 组内配对的最低综合分
TIE_EPS = 0.03          # 候选并列：前两名分差不超过该值即视为并列
SUBJECT_CONTAIN_SCORE = 0.85   # 主体互相包含时的相似度

_CHANGE_TYPE_LABEL = {
    "unchanged": "未变更", "rewrite": "改写", "added": "新增",
    "deleted": "删除", "split": "拆分", "merged": "合并",
    "multi_rewrite": "多段改写",
}


def _norm_text(s: str | None) -> str:
    return _NORM_RE.sub("", s or "")


# ---------------- 时限提取与比较 ----------------

def _find_deadline(action: str) -> str | None:
    for rx in DEADLINE_RES:
        m = rx.search(action)
        if m:
            return m.group(0)
    return None


def _deadline_key(dl: str | None):
    """时限 → 可比较的键：("num", 数值, 单位类) / ("kw", 关键词) / ("text", 归一化文本)。

    单位类换算（公开规则）：天→日；周/星期→7 日；个工作日独立一类
    （不与自然日互相换算）；月/年各自一类；不同单位类不比较长短，
    只判“内容变化”。
    """
    if not dl:
        return None
    m = _DL_NUM_UNIT_RE.search(dl)
    if m:
        num = parse_num(m.group(1))
        unit = m.group(2)
        if num is not None:
            if unit == "天":
                unit = "日"
            elif unit in ("周", "星期"):
                num *= 7
                unit = "日"
            elif unit == "个月":
                unit = "月"
            return ("num", num, unit)
    for kw in ("立即", "及时", "当场", "随时"):
        if kw in dl:
            return ("kw", kw)
    return ("text", _norm_text(dl))


def compare_deadlines(old_dl: str | None, new_dl: str | None) -> str:
    """same / added / removed / shorter / longer / changed。"""
    if not old_dl and not new_dl:
        return "same"
    if not old_dl:
        return "added"
    if not new_dl:
        return "removed"
    ko, kn = _deadline_key(old_dl), _deadline_key(new_dl)
    if ko is not None and ko == kn:
        return "same"
    if ko and kn and ko[0] == kn[0] == "num" and ko[2] == kn[2]:
        if kn[1] < ko[1]:
            return "shorter"
        if kn[1] > ko[1]:
            return "longer"
        return "same"
    if _norm_text(old_dl) == _norm_text(new_dl):
        return "same"
    return "changed"


# ---------------- 义务项提取 ----------------

def extract_obligations(paragraphs: list[str], side: str, struct=None) -> list[dict]:
    """按公开规则从一侧段落提取义务项（主体＋情态词＋行为＋时限）。

    每项含所在段落、句内序号、段落内字符偏移（供前端高亮依据原文）、
    主体（可能为 None / 承前继承）、情态词、行为、时限与所在句原文。
    """
    struct = struct if struct is not None else build_structure(paragraphs)
    obs: list[dict] = []
    for pi, text in enumerate(paragraphs):
        art = struct.para_art.get(pi)
        loc = f"{side}版第 {pi + 1} 段" + (f" · 第{int_to_cn(art)}条" if art is not None else "")
        sent_seq = 0
        for sm in _SENT_RE.finditer(text):
            sent = sm.group(0)
            if not sent.strip():
                continue
            sent_obs: list[dict] = []
            for mm in MODAL_RE.finditer(sent):
                modal = mm.group(0)
                pre = sent[:mm.start()]
                clause = _CLAUSE_SPLIT_RE.split(pre)[-1] if pre else ""
                clause = _LEAD_CONN_RE.sub("", clause.strip())
                clause = _TAIL_CONN_RE.sub("", clause).strip()
                # 主体首部的结构编号（第X条/（一）/1. 等）不计入主体
                while True:
                    stripped = _STRUCT_HEAD_RE.sub("", clause, count=1).strip()
                    if stripped == clause:
                        break
                    clause = stripped
                if clause and MODAL_RE.search(clause):
                    # 分句内仍含前一情态词（承前长句），不截句子中段充当主体
                    clause = ""
                subject = clause or None
                inherited = False
                if subject is None and sent_obs and sent_obs[-1]["subject"]:
                    subject = sent_obs[-1]["subject"]
                    inherited = True
                nxt = MODAL_RE.search(sent, mm.end())
                end = nxt.start() if nxt else len(sent)
                if nxt is not None:
                    # 行为在下一情态词前的最后一个句内标点处截断，
                    # 标点后的短语留给下一义务项作主体候选
                    puncts = list(_CLAUSE_SPLIT_RE.finditer(sent, mm.end(), end))
                    if puncts:
                        end = puncts[-1].start()
                action = sent[mm.end():end]
                action = action.strip(" \t　，。；、：,.;:")
                action = _TAIL_CONN_RE.sub("", action)
                ob = {
                    "side": side,
                    "para_idx": pi,
                    "sent_idx": sent_seq,
                    "start": sm.start(),
                    "end": sm.end(),
                    "subject": subject,
                    "subject_inherited": inherited,
                    "modal": modal,
                    "action": action,
                    "deadline": _find_deadline(action),
                    "sentence": sent.strip(),
                    "location": loc,
                }
                sent_obs.append(ob)
                obs.append(ob)
            sent_seq += 1
    for i, ob in enumerate(obs):
        ob["seq"] = i
    return obs


# ---------------- 组内配对 ----------------

def _subject_sim(a: str, b: str) -> float:
    na, nb = _norm_text(a), _norm_text(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if na in nb or nb in na:
        return SUBJECT_CONTAIN_SCORE
    return similarity(a, b)


def _pair_score(o: dict, n: dict) -> tuple[float, float, float]:
    """(综合分, 主体相似度, 行为相似度)；情态词不参与打分。"""
    s = _subject_sim(o["subject"], n["subject"])
    a = similarity(o["action"], n["action"])
    return round(0.5 * s + 0.5 * a, 6), round(s, 6), round(a, 6)


def _ob_brief(ob: dict) -> str:
    act = ob["action"]
    act = act[:20] + "…" if len(act) > 20 else act
    return f"{ob['subject'] or '（无主体）'}·{ob['modal']}·{act}（{ob['location']}）"


def classify_pair(o: dict, n: dict) -> tuple[str | None, str]:
    """已配对义务项的变更判定；完全一致的配对返回 (None, "")。"""
    om, nm = o["modal"], n["modal"]
    if om == nm:
        dl = compare_deadlines(o["deadline"], n["deadline"])
        act_same = _norm_text(o["action"]) == _norm_text(n["action"])
        if dl == "same" and act_same:
            return None, ""
        if dl == "added":
            return "strengthened", f"情态词同为「{om}」，新版新增时限约束「{n['deadline']}」，义务加强"
        if dl == "removed":
            return "weakened", f"情态词同为「{om}」，新版取消旧版时限「{o['deadline']}」，义务弱化"
        if dl == "shorter":
            return "strengthened", f"情态词同为「{om}」，时限由「{o['deadline']}」缩短为「{n['deadline']}」，义务加强"
        if dl == "longer":
            return "weakened", f"情态词同为「{om}」，时限由「{o['deadline']}」放宽为「{n['deadline']}」，义务弱化"
        if dl == "changed":
            return "changed", (f"情态词同为「{om}」，时限由「{o['deadline']}」改为「{n['deadline']}」"
                               f"（单位/形式无法直接比较长短），判为内容变化")
        sim = similarity(o["action"], n["action"])
        return "changed", f"情态词同为「{om}」，行为表述变化（行为相似度 {sim * 100:.0f}%），判为内容变化"

    if om == "不得":
        judgment = "relaxed"
        head = f"禁止性规定放宽：情态词由「不得」变为「{nm}」（{MODAL_DESC[nm]}）"
    elif nm == "不得":
        judgment = "strengthened"
        head = f"新增禁止性规定：情态词由「{om}」（{MODAL_DESC[om]}）变为「不得」"
    elif MODAL_RANK[nm] > MODAL_RANK[om]:
        judgment = "strengthened"
        head = f"义务加强：情态词由「{om}」（{MODAL_DESC[om]}）提升为「{nm}」（{MODAL_DESC[nm]}）"
    else:
        judgment = "weakened"
        head = f"义务弱化：情态词由「{om}」（{MODAL_DESC[om]}）降为「{nm}」（{MODAL_DESC[nm]}）"
    extras = []
    dl = compare_deadlines(o["deadline"], n["deadline"])
    if dl == "added":
        extras.append(f"同时新增时限「{n['deadline']}」")
    elif dl == "removed":
        extras.append(f"同时取消时限「{o['deadline']}」")
    elif dl in ("shorter", "longer", "changed"):
        extras.append(f"时限由「{o['deadline']}」变为「{n['deadline']}」")
    if _norm_text(o["action"]) != _norm_text(n["action"]):
        extras.append("行为表述亦有调整")
    return judgment, head + ("；" + "；".join(extras) if extras else "")


# ---------------- 主分析入口 ----------------

def analyze_obligations(old_paragraphs: list[str], new_paragraphs: list[str],
                        alignments: list[dict]) -> dict:
    """计算责任矩阵（即时计算，不落库）。

    ``alignments`` 为对齐记录 dict（含 ``old_indices/new_indices`` 列表）。
    """
    old_struct = build_structure(old_paragraphs)
    new_struct = build_structure(new_paragraphs)
    old_obs = extract_obligations(old_paragraphs, "旧", old_struct)
    new_obs = extract_obligations(new_paragraphs, "新", new_struct)

    old_by_para: dict[int, list[dict]] = {}
    for ob in old_obs:
        old_by_para.setdefault(ob["para_idx"], []).append(ob)
    new_by_para: dict[int, list[dict]] = {}
    for ob in new_obs:
        new_by_para.setdefault(ob["para_idx"], []).append(ob)

    items: list[dict] = []
    counts = {k: 0 for k in JUDGMENT_LABEL}
    stats = {"unchanged_pairs": 0, "matched_pairs": 0,
             "groups_paired": 0, "groups_skipped": 0}

    def emit(judgment, alignment_id, group_desc, old_ob, new_ob,
             candidates, score, reason, basis):
        counts[judgment] += 1
        items.append({
            "judgment": judgment,
            "alignment_id": alignment_id,
            "group_desc": group_desc,
            "score": score,
            "old": old_ob,
            "new": new_ob,
            "candidates": candidates,
            "reason": reason,
            "basis": basis,
        })

    def group_desc(a: dict) -> str:
        ct = _CHANGE_TYPE_LABEL.get(a.get("change_type"), a.get("change_type") or "映射")
        old_ps = "、".join(f"第{x + 1}段" for x in a["old_indices"]) or "无"
        new_ps = "、".join(f"第{x + 1}段" for x in a["new_indices"]) or "无"
        manual = "，人工调整" if a.get("is_manual") else ""
        return f"对齐记录 #{a['id']}（{ct}：旧版{old_ps} ↔ 新版{new_ps}{manual}）"

    mapped_old: set[int] = set()
    mapped_new: set[int] = set()
    for a in alignments:
        mapped_old.update(a["old_indices"])
        mapped_new.update(a["new_indices"])

    def process_one_to_one(a, gdesc, olds, news):
        """1 旧 ↔ 1 新映射组：主体缺失先隔离，其余按主体＋行为相似度互选配。"""
        stats["groups_paired"] += 1
        old_ok = [ob for ob in olds if ob["subject"]]
        old_miss = [ob for ob in olds if not ob["subject"]]
        new_ok = [ob for ob in news if ob["subject"]]
        new_miss = [ob for ob in news if not ob["subject"]]
        for ob in old_miss:
            emit("review", a["id"], gdesc, ob, None, list(news), None,
                 "旧版侧义务主体缺失（句子以情态词开头且同句无可继承主体），"
                 "按规则不得强行匹配；下方列出组内新版全部义务项供人工核验",
                 f"{gdesc}；主体缺失的义务项不参与自动配对")
        for ob in new_miss:
            emit("review", a["id"], gdesc, None, ob, list(olds), None,
                 "新版侧义务主体缺失（句子以情态词开头且同句无可继承主体），"
                 "按规则不得强行匹配；下方列出组内旧版全部义务项供人工核验",
                 f"{gdesc}；主体缺失的义务项不参与自动配对")

        # 打分矩阵（仅主体非缺失项之间）
        old_ranked: dict[int, list] = {}
        for o in old_ok:
            lst = [(_pair_score(o, n)[0], n) for n in new_ok]
            lst.sort(key=lambda x: (-x[0], x[1]["seq"]))
            old_ranked[o["seq"]] = [(s, n) for s, n in lst if s >= PAIR_THRESHOLD]
        new_ranked: dict[int, list] = {}
        for n in new_ok:
            lst = [(_pair_score(o, n)[0], o) for o in old_ok]
            lst.sort(key=lambda x: (-x[0], x[1]["seq"]))
            new_ranked[n["seq"]] = [(s, o) for s, o in lst if s >= PAIR_THRESHOLD]

        def tied(ranked) -> bool:
            return len(ranked) > 1 and ranked[0][0] - ranked[1][0] <= TIE_EPS

        paired: dict[int, tuple[dict, float]] = {}
        used_new: set[int] = set()
        for o in old_ok:
            ro = old_ranked[o["seq"]]
            if not ro or tied(ro):
                continue
            s0, n0 = ro[0]
            rn = new_ranked[n0["seq"]]
            if not rn or tied(rn):
                continue
            if rn[0][1]["seq"] == o["seq"] and n0["seq"] not in used_new:
                paired[o["seq"]] = (n0, s0)
                used_new.add(n0["seq"])

        n_old_ok = len(old_ok)
        n_new_ok = len(new_ok)
        for o in old_ok:
            if o["seq"] not in paired:
                continue
            n0, s0 = paired[o["seq"]]
            _, s_subj, s_act = _pair_score(o, n0)
            stats["matched_pairs"] += 1
            judgment, reason = classify_pair(o, n0)
            if judgment is None:
                stats["unchanged_pairs"] += 1
                continue
            basis = (f"{gdesc}；组内旧版义务 {n_old_ok} 项、新版义务 {n_new_ok} 项；"
                     f"综合分 = 0.5×主体相似度 {s_subj:.2f} + 0.5×行为相似度 {s_act:.2f} "
                     f"= {s0:.2f} ≥ 阈值 {PAIR_THRESHOLD}，且互为最优候选（无并列）")
            emit(judgment, a["id"], gdesc, o, n0, [], s0, reason, basis)

        for o in old_ok:
            if o["seq"] in paired:
                continue
            ro = old_ranked[o["seq"]]
            if not ro:
                if not new_ok:
                    reason = ("映射组新版侧未提取到义务项（无「应当/必须/不得/可以」锚点），"
                              "旧版义务项在新版无对应，判定为移除")
                else:
                    best = max(_pair_score(o, n)[0] for n in new_ok)
                    reason = (f"组内新版侧 {n_new_ok} 项义务与该项的综合分均低于配对阈值 "
                              f"{PAIR_THRESHOLD}（最高 {best:.2f}），判定为移除")
                emit("removed", a["id"], gdesc, o, None, [], None, reason,
                     f"{gdesc}；组内配对无一达到阈值")
                continue
            cands = [n for _, n in ro]
            if tied(ro):
                briefs = "、".join(f"候选「{_ob_brief(n)}」{s:.2f} 分" for s, n in ro[:2])
                reason = (f"候选并列：新版侧前两名候选综合分相差不足 {TIE_EPS}（{briefs}），"
                          "按规则不得强行匹配，需人工核验")
            else:
                s0, n0 = ro[0]
                reason = (f"候选竞争未互选：本项最优候选为「{_ob_brief(n0)}」（{s0:.2f} 分），"
                          "但该候选的最优配对对象是组内另一旧版义务项，未形成互选，"
                          "按规则不得强行匹配，需人工核验")
            emit("review", a["id"], gdesc, o, None, cands, None, reason,
                 f"{gdesc}；候选按综合分降序列出，均未强行选取")

        for n in new_ok:
            if n["seq"] in used_new:
                continue
            rn = new_ranked[n["seq"]]
            if not rn:
                if not old_ok:
                    reason = ("映射组旧版侧未提取到义务项（无「应当/必须/不得/可以」锚点），"
                              "新版义务项在旧版无来源，判定为新增")
                else:
                    best = max(_pair_score(o, n)[0] for o in old_ok)
                    reason = (f"组内旧版侧 {n_old_ok} 项义务与该项的综合分均低于配对阈值 "
                              f"{PAIR_THRESHOLD}（最高 {best:.2f}），判定为新增")
                emit("added", a["id"], gdesc, None, n, [], None, reason,
                     f"{gdesc}；组内配对无一达到阈值")
                continue
            cands = [o for _, o in rn]
            if tied(rn):
                briefs = "、".join(f"候选「{_ob_brief(o)}」{s:.2f} 分" for s, o in rn[:2])
                reason = (f"候选并列：旧版侧前两名候选综合分相差不足 {TIE_EPS}（{briefs}），"
                          "按规则不得强行匹配，需人工核验")
            else:
                s0, o0 = rn[0]
                reason = (f"候选竞争未互选：本项最优候选为「{_ob_brief(o0)}」（{s0:.2f} 分），"
                          "但该候选的最优配对对象是组内另一新版义务项，未形成互选，"
                          "按规则不得强行匹配，需人工核验")
            emit("review", a["id"], gdesc, None, n, cands, None, reason,
                 f"{gdesc}；候选按综合分降序列出，均未强行选取")

    for a in alignments:
        o_idx, n_idx = a["old_indices"], a["new_indices"]
        olds = [ob for i in o_idx for ob in old_by_para.get(i, [])]
        news = [ob for i in n_idx for ob in new_by_para.get(i, [])]
        if not olds and not news:
            continue
        gdesc = group_desc(a)
        if not o_idx:
            for ob in news:
                emit("added", a["id"], gdesc, None, ob, [], None,
                     "新版段落为纯新增映射，该义务项在旧版无来源，判定为新增",
                     f"{gdesc}；新版段落无旧版对应，无需配对")
            continue
        if not n_idx:
            for ob in olds:
                emit("removed", a["id"], gdesc, ob, None, [], None,
                     "旧版段落为纯删除映射，该义务项在新版无去向，判定为移除",
                     f"{gdesc}；旧版段落无新版对应，无需配对")
            continue
        if len(o_idx) > 1 or len(n_idx) > 1:
            stats["groups_skipped"] += 1
            ct = _CHANGE_TYPE_LABEL.get(a.get("change_type"), "多段")
            for ob in olds:
                emit("review", a["id"], gdesc, ob, None, list(news), None,
                     f"映射组为{ct}（旧 {len(o_idx)} 段 ↔ 新 {len(n_idx)} 段），"
                     "按规则拆分/合并映射组内不做强行配对；对侧义务项列为候选，需人工核验",
                     f"{gdesc}；拆分/合并组内不自动配对")
            for ob in news:
                emit("review", a["id"], gdesc, None, ob, list(olds), None,
                     f"映射组为{ct}（旧 {len(o_idx)} 段 ↔ 新 {len(n_idx)} 段），"
                     "按规则拆分/合并映射组内不做强行配对；对侧义务项列为候选，需人工核验",
                     f"{gdesc}；拆分/合并组内不自动配对")
            continue
        process_one_to_one(a, gdesc, olds, news)

    # 未参与任何映射的段落：无法确认对应关系，保守列为待核验
    for ob in old_obs:
        if ob["para_idx"] not in mapped_old:
            emit("review", None, "（旧版段落未参与任何映射）", ob, None, [], None,
                 "所在旧版段落未被任何对齐记录引用（映射可能被人工删除），"
                 "无法确定两版对应关系，需人工核验",
                 "段落不在任何对齐记录中，按规则不强行匹配")
    for ob in new_obs:
        if ob["para_idx"] not in mapped_new:
            emit("review", None, "（新版段落未参与任何映射）", None, ob, [], None,
                 "所在新版段落未被任何对齐记录引用（映射可能被人工删除），"
                 "无法确定两版对应关系，需人工核验",
                 "段落不在任何对齐记录中，按规则不强行匹配")

    return {
        "items": items,
        "counts": counts,
        "total": len(items),
        "unchanged_pairs": stats["unchanged_pairs"],
        "matched_pairs": stats["matched_pairs"],
        "groups_paired": stats["groups_paired"],
        "groups_skipped": stats["groups_skipped"],
        "n_old_obligations": len(old_obs),
        "n_new_obligations": len(new_obs),
        "judgment_labels": JUDGMENT_LABEL,
        "modals": list(MODALS),
    }
