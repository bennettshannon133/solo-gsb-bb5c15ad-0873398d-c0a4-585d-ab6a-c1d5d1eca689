"""责任矩阵：从两版条款中提取义务项并在**现有段落映射组内**保守配对、判定。

全部规则均为**公开的确定性规则**（无模型、无外部 NLP 依赖），便于复核与复现。

一、义务项提取（``extract_obligations``）
1. **小句切分**：以 ``。；！？`` 为句末边界切分小句（保留字符偏移，供前端高亮）；
2. **情态触发词**（按长度优先匹配，公开词表）：
   - 禁止类：``不得``；
   - 强命令类：``必须``；
   - 命令类：``应当``；（另支持单字 ``应``，但其前一字为
     “不/也/还/都/相/响/答/反/效/适/感/接/相”等时排除，避免“反应/相应”误判）；
   - 许可类：``可以``、``方可``；
   同一句出现多个触发词时，按出现位置切分为多条义务（如“应当 A，不得 B”）。
3. **主体**：取触发词前的句首片段——
   - 剥离开头条号（``第X条``）；
   - 剥离并循环剥离体言/条件状语引导词
     （对/对于/关于/经/经过/根据/依据/按照/按/因/为了/在/于/向/从/由/把/被/将
     及其后到逗号/“后”的片段）；
   - 剥离并/且/而/则/但/同时/此外/另外/还/也/又 等连接词；
   - 被动式“被 X……”取 X 为主体；
   - 剩余片段长度 2~12 字且不以介词开头才接受为主体，否则记为**主体缺失**；
   - 同句中后一条义务的主体若被状语/条件吞没，可**承前继承**同句上一条义务的主体
     （``subject_inherited=True``）；**不跨句继承、不臆测主体**。
4. **行为**：触发词之后到句末或下一触发词之前的片段，去除首尾标点。
5. **时限**：在义务片段内按公开正则扫描（命中最长跨度）：
   “自/于/在……（之）前/以前/内/时/起”、“期限为……”、
   “数词 + 个工作日/日/天/个月/月/年/小时/周 + 内/前”、“提前……（时长）”、
   裸“提前”（未注明时长照录）。

二、配对（``analyze_obligations``）——**只在现有段落映射组内、禁止强行匹配**
1. 仅 ``old_indices`` 与 ``new_indices`` 均非空、且两侧各恰为 **1 个段落**的 1:1
   映射组允许自动配对；
2. **拆分 / 合并 / 多段改写**组一律不自动配对，组内每条义务列为 **待核验**，
   仍给出对侧候选与原因；
3. 纯新增 / 纯删除组内义务直接判为 **新增 / 移除**（该组内不存在对侧义务）；
4. 1:1 组内相似度：
   ``综合 = 0.45 × 主体相似度 + 0.55 × 行为相似度``
   （复用 ``aligner.similarity``）。两侧主体均存在且主体相似度 ≥ 0.30 才视为兼容；
   综合相似度 ≥ 0.45 且行为相似度 ≥ 0.30 才进入候选；
5. 采用**双向互最佳**贪心配对：旧义务的最佳新候选同时以该旧义务为最佳新候选时
   才配对；每轮配对后移除已配项再迭代；
6. **不得强行匹配**的三种情形均判 **待核验** 并展示候选（含相似度）与原因：
   - 任一侧**主体缺失**（含承前继承失败）；
   - **候选并列**：最佳候选与次佳候选综合分差 ≤ 0.06（且均达门槛），
     互最佳不唯一，并列各方一并列为待核验；
   - 无候选达门槛时不配对（旧项→移除、新项→新增），同时列出最相近的未达门槛项。

三、判定（八类，优先级自上而下）
``forbid→may`` 同行为 → **禁止放宽**；情态强度上升（可以→应当/必须/不得、
应当→必须/不得）→ **加强**；强度下降（必须→应当、不得/必须→应当/可以 等）→
**弱化**；强度同级时，情态相同、行为相似度 ≥ 0.90 且时限一致 → **未变化**；
否则（行为改写、时限调整等）→ **内容变化**。仅单侧存在 → **新增 / 移除**；
保守不配对 → **待核验**。时限变化不改变强度，只在判定说明中写明两版时限。
"""
from __future__ import annotations

import re

from .aligner import _normalize, similarity
from .citations import _art_label, build_structure

# ---------------- 公开常量 ----------------

MODAL_LABEL = {"shall": "应当", "must": "必须", "forbid": "不得", "may": "可以"}
# 情态强度：许可 1 < 应当 2 < 必须/不得 3
MODAL_STRENGTH = {"may": 1, "shall": 2, "must": 3, "forbid": 3}

VERDICT_LABEL = {
    "added": "新增",
    "removed": "移除",
    "strengthened": "加强",
    "weakened": "弱化",
    "forbid_relaxed": "禁止放宽",
    "changed": "内容变化",
    "unchanged": "未变化",
    "review": "待核验",
}

GROUP_TYPE_LABEL = {
    "unchanged": "未变更", "rewrite": "改写", "added": "新增", "deleted": "删除",
    "split": "拆分", "merged": "合并", "multi_rewrite": "多段改写",
}

# 触发词。多字优先；单字「应」做前字排除，且与多字触发词重叠时丢弃。
_TRIGGER_RE = re.compile(r"不得|必须|应当|可以|方可|应")
# 单字「应」前一字若为这些字，说明它是另一词的组成部分（供应商/相应/反应/应用…）
_SHALL_SINGLE_EXCLUDE_PREV = set(
    "不也还都相响答反效适感接对变用供变内答理")
_MULTI_TRIGGER_KEY = {"不得": "forbid", "必须": "must", "应当": "shall",
                      "可以": "may", "方可": "may"}
_SENTENCE_SPLIT_RE = re.compile(r"[^。；！？!?]+[。；！？!?]?")
_ART_HEAD_RE = re.compile(r"^\s*第[一二三四五六七八九十百零〇0-9]+条(?:之[一二三四五六七八九十0-9]+)?[ 　]*")

# 主体清洗
_LEADING_CONJ_RE = re.compile(r"^(?:并且|同时|此外|另外|但是|然而|于是|然后|接着|并|且|而|则|但|还|也|又|再|可|便|就)\s*")
_PREP_CHARS = "对关于经过根依据按照因在向从由把被将"
# 句中条件/状语片段（可能出现在主体之后，如“请假经直接主管批准后”）：定位最后一处并截断
_MID_COND_RE = re.compile(
    r"(?:对于|关于|经过|根据|依据|按照|为了|对|经|按|因|在|于|向|从|由|把|将)"
    r"[^，,。；;]{0,40}?(?:[，,]|之后|以后|后|起|之前|以前|前|时)"
)
_MAX_SUBJECT_LEN = 12
_MIN_SUBJECT_LEN = 2

# 时限正则（公开规则，按顺序匹配，取最长跨度）
_TIME_PATTERNS = [
    re.compile(r"(?:自|于|在)([^，,。；;]{1,18}?)(?:之前|以前|前|内|以内|时|的时候|起)"),
    re.compile(r"期限为([^，,。；;]{1,18})"),
    re.compile(r"([0-9０-９零〇一二两三四五六七八九十百千]+(?:个?工作日|日|天|个月|月|年|小时|周))(?:内|以内|前|以前|之前)"),
    re.compile(r"提前((?:[^，,。；;]{0,6}?)?(?:个?工作日|日|天|个月|月|年|小时|周))"),
]
_BARE_EARLY_RE = re.compile(r"提前")

# 配对阈值（公开）
SUBJ_COMPAT = 0.30      # 两侧主体相似度低于此值视为主体不兼容
PAIR_GATE = 0.45        # 综合相似度配对门槛
ACTION_GATE = 0.30      # 行为相似度门槛
TIE_BAND = 0.06         # 最佳与次佳分差 ≤ 此值视为候选并列
UNCHANGED_ACTION = 0.90  # 判“未变化”的行为相似度
PAIR_W_SUBJ = 0.45
PAIR_W_ACT = 0.55

# ---------------- 义务项提取 ----------------


def _clean_subject(seg: str) -> tuple[str | None, bool]:
    """从句首片段清洗主体，返回 (主体 or None, 是否被动式)。"""
    s = seg.strip()
    s = _ART_HEAD_RE.sub("", s).strip()
    passive = False
    # 截断最后一个条件/状语片段（如“请假经直接主管批准后”→“请假”）
    mids = list(_MID_COND_RE.finditer(s))
    if mids:
        tail = s[mids[-1].end():]
        if not tail.strip():
            s = s[:mids[-1].start()].strip()
    # “……的员工 / 的部门，人力资源部应当……”：取逗号后真正的主语；
    # “因公出差的员工必须……”：剥离“的”前定语，保留中心主体
    de_comma = re.search(
        r"的(?:员工|部门|人员|申请人|单位|公司|机构|负责人|主管|经理|审批人)[，,]\s*"
        r"([^，,。；;]{2,12})$", s)
    if de_comma:
        s = de_comma.group(1).strip()
    else:
        de_m = re.search(r"的(?:员工|部门|人员|申请人|单位|公司|机构|负责人|主管|经理|审批人)$", s)
        if de_m:
            s = s[de_m.start() + 1:]
    # 循环剥离连接词与句首介词/条件状语片段
    for _ in range(4):
        prev = s
        s = _LEADING_CONJ_RE.sub("", s).strip()
        m = _MID_COND_RE.match(s)
        if m and m.start() == 0:
            s = s[m.end():].strip()
        if s == prev:
            break
    if not s:
        return None, passive
    if s.startswith("被"):
        passive = True
        s = s[1:].strip()
    if not s or s[0] in _PREP_CHARS:
        return None, passive
    # 尾部副词/否定残留（“员工不应当…”中的“不”、“员工也应当…”中的“也”）
    s = re.sub(r"(?:也|都|还|又|再|就|便|则|不|没)$", "", s).strip()
    # 纯条件/时间状语残留（无实体主体）：去尾标点后以“……的/地/得/后/前/时”结尾判缺失
    if not s:
        return None, passive
    if re.search(r"(?:的|地|得|后|前|时)$", s.rstrip("，,、 ")):
        return None, passive
    if not (_MIN_SUBJECT_LEN <= len(_normalize(s)) <= _MAX_SUBJECT_LEN):
        return None, passive
    return s, passive


def _extract_time(clause: str) -> str:
    """按公开正则在义务片段内扫描时限，取最长命中；裸“提前”照录。"""
    best = ""
    for pat in _TIME_PATTERNS:
        for m in pat.finditer(clause):
            txt = m.group(0).strip("，,。；; ")
            if len(txt) > len(best):
                best = txt
    if not best and _BARE_EARLY_RE.search(clause):
        best = "提前（未注明具体时长）"
    return best


def _triggers(sent_start: int, sent_text: str):
    """小句内触发词 → [(abs_start, abs_end, modal_key, modal_text)]。

    - 同一起始位置可能同时匹配多个触发词（“双方可以”里位置 2 的“可以”与
      位置 3 起的假“方可”），**起点靠前者优先且长词优先**，丢弃被包含的假匹配；
    - 单字「应」前字为构词成分（供应商/相应/反应…）时排除。
    """
    raws = []  # (start, end, key, text, is_single)
    for m in _TRIGGER_RE.finditer(sent_text):
        word = m.group(0)
        if word == "应":
            prev_ch = sent_text[m.start() - 1] if m.start() > 0 else ""
            if prev_ch in _SHALL_SINGLE_EXCLUDE_PREV:
                continue
            raws.append((m.start(), m.end(), "shall", "应", True))
        elif word == "方可":
            # 交替正则会把“双方可以”里的“方+可以”从“方”起误匹配为“方可”。
            # 此时其后字为“以”（即“方可”其实跨过了真“可以”的首字），
            # 还原为该位置内真正的“可以”（start+1）。
            if sent_text[m.start() + 2:m.start() + 3] == "以":
                raws.append((m.start() + 1, m.end() + 1, "may", "可以", False))
            else:
                raws.append((m.start(), m.end(), "may", "方可", False))
        else:
            raws.append((m.start(), m.end(), _MULTI_TRIGGER_KEY[word], word, False))
    # 单字「应」与多字触发词区间重叠时丢弃
    multi_spans = [(s, e) for s, e, _, _, single in raws if not single]
    out = []
    for s, e, key, text, single in raws:
        if single and any(ms <= s < me for ms, me in multi_spans):
            continue
        out.append((sent_start + s, sent_start + e, key, text))
    out.sort(key=lambda x: x[0])
    return out


def extract_obligations(paragraphs: list[str], side: str) -> list[dict]:
    """提取一侧文本的全部义务项（按段落、出现顺序）。

    ``side`` 仅用于标签："old"/"new"。
    """
    struct = build_structure(paragraphs)
    obs: list[dict] = []
    for pidx, para in enumerate(paragraphs):
        art = struct.para_art.get(pidx)
        art_label = _art_label(art) if art is not None else ""
        order = 0
        for sm in _SENTENCE_SPLIT_RE.finditer(para):
            sent = sm.group(0)
            if not sent.strip():
                continue
            s0, s1 = sm.start(), sm.end()
            trigs = _triggers(s0, sent)
            if not trigs:
                continue
            prev_subject: str | None = None  # 仅同句承前
            for ti, (t0, t1, modal, modal_text) in enumerate(trigs):
                next_trig = trigs[ti + 1][0] if ti + 1 < len(trigs) else s1
                # 前一条义务的行为截到下一触发词前最后一个逗号，避免越界吃到
                # 下一条义务的主语/状语（如“提前申请，经主管批准后方可休假”）
                action_end = next_trig
                if ti + 1 < len(trigs):
                    gap = para[t1:next_trig]
                    last_comma = max(gap.rfind("，"), gap.rfind(","), gap.rfind("、"))
                    if last_comma >= 0:
                        action_end = t1 + last_comma
                clause_end = next_trig
                prefix = para[s0:t0] if ti == 0 else para[trigs[ti - 1][1]:t0]
                # 同句非首条义务：主体在“上一触发词之后、本触发词之前”，取最后一个逗号后的片段
                if ti > 0:
                    tail_m = list(re.finditer(r"[，,、]", prefix))
                    prefix = prefix[tail_m[-1].end():] if tail_m else ""
                    # 逗号后只剩连接词/状语（如“也可以…”）视为未给新主语 → 承前
                    probe = _LEADING_CONJ_RE.sub("", prefix).strip()
                    if not probe or probe.startswith(("也", "都", "还", "又", "再", "就", "便", "则")):
                        prefix = ""
                subject, passive = _clean_subject(prefix)
                inherited = False
                if subject is None and prev_subject is not None:
                    subject, inherited = prev_subject, True
                action = para[t1:action_end].strip(" 　\t，,。；;！!？?、")
                clause_text = para[t0:clause_end].strip(" 　\t，,。；;")
                time_limit = _extract_time(para[t1:action_end])
                obs.append({
                    "id": f"{side}-{pidx}-{order}",
                    "side": side,
                    "para_idx": pidx,
                    "art_label": art_label,
                    "location": f"{'旧版' if side == 'old' else '新版'}第 {pidx + 1} 段"
                                + (f"（{art_label}）" if art_label else ""),
                    "sent_start": s0,
                    "sent_end": s1,
                    "trig_start": t0,
                    "trig_end": t1,
                    "modal": modal,
                    "modal_text": modal_text,
                    "subject": subject,
                    "subject_missing": subject is None,
                    "subject_inherited": inherited,
                    "passive": passive,
                    "action": action,
                    "time_limit": time_limit,
                    "clause_text": clause_text,
                })
                order += 1
                if not inherited and subject is not None:
                    prev_subject = subject
    return obs


# ---------------- 组内配对 ----------------


def _pair_score(o: dict, n: dict, cache: dict) -> dict:
    ss = similarity(o["subject"] or "", n["subject"] or "", cache)
    aa = similarity(o["action"], n["action"], cache)
    total = round(PAIR_W_SUBJ * ss + PAIR_W_ACT * aa, 6)
    return {"subject_sim": round(ss, 4), "action_sim": round(aa, 4), "score": round(total, 4)}


def _candidate(ob: dict, other: dict, sc: dict, why: str) -> dict:
    return {
        "obligation": other,
        "subject_sim": sc["subject_sim"],
        "action_sim": sc["action_sim"],
        "score": sc["score"],
        "eligible": sc["score"] >= PAIR_GATE and sc["action_sim"] >= ACTION_GATE,
        "why": why,
    }


def _rank(old_obs: list[dict], new_obs: list[dict], cache: dict,
          allow_missing_subject: bool = False):
    """计算双向候选排名。返回 old_rank[o_i]=[(n_j, sc)...] 降序，及反向。

    默认仅两侧主体均存在且兼容才计入（供自动配对）；
    ``allow_missing_subject=True`` 时主体缺失也按行为相似度列候选
    （仅供待核验展示，绝不自动配对）。
    """
    old_rank: dict[int, list[tuple[int, dict]]] = {i: [] for i in range(len(old_obs))}
    new_rank: dict[int, list[tuple[int, dict]]] = {j: [] for j in range(len(new_obs))}
    for i, o in enumerate(old_obs):
        for j, n in enumerate(new_obs):
            sc = _pair_score(o, n, cache)
            if allow_missing_subject:
                if not o["subject_missing"] and not n["subject_missing"]:
                    compatible = sc["subject_sim"] >= SUBJ_COMPAT
                else:
                    # 主体缺失：候选仅供人工查看，按行为相似度排序
                    compatible = sc["action_sim"] > 0.0
            else:
                compatible = (not o["subject_missing"] and not n["subject_missing"]
                              and sc["subject_sim"] >= SUBJ_COMPAT)
            if compatible:
                old_rank[i].append((j, sc))
                new_rank[j].append((i, sc))
    for lst in old_rank.values():
        lst.sort(key=lambda x: x[1]["score"], reverse=True)
    for lst in new_rank.values():
        lst.sort(key=lambda x: x[1]["score"], reverse=True)
    return old_rank, new_rank


def _verdict(o: dict, n: dict, sc: dict) -> tuple[str, str]:
    """配对成功后的判定与说明。"""
    om, nm = o["modal"], n["modal"]
    so, sn = MODAL_STRENGTH[om], MODAL_STRENGTH[nm]
    ot, nt = (o["time_limit"] or "").strip(), (n["time_limit"] or "").strip()
    time_same = _normalize_time(ot) == _normalize_time(nt)
    time_note = ""
    if not time_same:
        time_note = f"；时限由「{ot or '无'}」调整为「{nt or '无'}」"
    modal_t = f"{MODAL_LABEL[om]}→{MODAL_LABEL[nm]}"

    if om == "forbid" and nm == "may":
        return "forbid_relaxed", (
            f"同一行为由禁止性义务（{o['modal_text']}）放宽为许可（{n['modal_text']}）"
            f"{time_note or '，时限未变' if time_same else ''}")
    if sn > so:
        return "strengthened", (
            f"义务强度加强（{modal_t}，强度 {so}→{sn}）"
            + (f"，行为相似度 {sc['action_sim'] * 100:.0f}%" )
            + (time_note or ("；时限一致" if time_same else "")))
    if sn < so:
        return "weakened", (
            f"义务强度弱化（{modal_t}，强度 {so}→{sn}）"
            + (f"，行为相似度 {sc['action_sim'] * 100:.0f}%")
            + (time_note or ("；时限一致" if time_same else "")))
    # 同级
    if om == nm and sc["action_sim"] >= UNCHANGED_ACTION and time_same:
        return "unchanged", (
            f"情态均为「{MODAL_LABEL[om]}」、行为相似度 {sc['action_sim'] * 100:.0f}%、"
            "时限一致，义务未变化")
    bits = []
    if om != nm:
        bits.append(f"情态措辞由「{o['modal_text']}」改为「{n['modal_text']}」（强度同级）")
    if sc["action_sim"] < UNCHANGED_ACTION:
        bits.append(f"行为表述发生变化（相似度 {sc['action_sim'] * 100:.0f}%）")
    if not time_same:
        bits.append(f"时限由「{ot or '无'}」改为「{nt or '无'}」")
    if not bits:
        bits.append("表述有非实质性差异")
    return "changed", "；".join(bits)


def _normalize_time(t: str) -> str:
    return re.sub(r"[\s　，,。、；；：:（）()]", "", t or "")


def _base_item(alignment: dict) -> dict:
    return {
        "alignment_id": alignment["id"],
        "group_change_type": alignment["change_type"],
        "old": None,
        "new": None,
        "subject_sim": None,
        "action_sim": None,
        "score": None,
        "old_candidates": [],
        "new_candidates": [],
    }


def _candidate_list(ob: dict, others: list[dict], rank: list[tuple[int, dict]],
                    blocked_why: str | None = None, limit: int = 3) -> list[dict]:
    """生成候选列表：达门槛标注 eligible；不足时给最相近项并写明原因。"""
    out = []
    for idx, sc in rank[:limit]:
        other = others[idx]
        if blocked_why:
            why = blocked_why
        elif sc["score"] < PAIR_GATE or sc["action_sim"] < ACTION_GATE:
            why = (f"综合相似度 {sc['score'] * 100:.0f}%（门槛 {PAIR_GATE * 100:.0f}%）"
                   f"或行为相似度 {sc['action_sim'] * 100:.0f}%（门槛 {ACTION_GATE * 100:.0f}%）"
                   "未达配对门槛，不自动配对")
        else:
            why = f"综合相似度 {sc['score'] * 100:.0f}%，达到配对门槛"
        out.append(_candidate(ob, other, sc, why))
    return out


def analyze_obligations(old_paragraphs: list[str], new_paragraphs: list[str],
                        alignments: list[dict]) -> dict:
    """责任矩阵主入口：提取 → 仅在现有映射组内保守配对 → 判定。"""
    old_obs_all = extract_obligations(old_paragraphs, "old")
    new_obs_all = extract_obligations(new_paragraphs, "new")
    old_by_para: dict[int, list[dict]] = {}
    new_by_para: dict[int, list[dict]] = {}
    for ob in old_obs_all:
        old_by_para.setdefault(ob["para_idx"], []).append(ob)
    for ob in new_obs_all:
        new_by_para.setdefault(ob["para_idx"], []).append(ob)

    items: list[dict] = []
    cache: dict = {}

    for a in alignments:
        ois, nis = a["old_indices"], a["new_indices"]
        old_obs = [ob for i in ois for ob in old_by_para.get(i, [])]
        new_obs = [ob for j in nis for ob in new_by_para.get(j, [])]

        # ---- 纯新增 / 纯删除组 ----
        if not ois:
            for n in new_obs:
                it = _base_item(a)
                it["new"] = n
                it["verdict"] = "added"
                it["reason"] = (
                    f"该映射组（{GROUP_TYPE_LABEL[a['change_type']]}）仅含新版段落、"
                    "旧版无对应段落，义务判为新增")
                items.append(it)
            continue
        if not nis:
            for o in old_obs:
                it = _base_item(a)
                it["old"] = o
                it["verdict"] = "removed"
                it["reason"] = (
                    f"该映射组（{GROUP_TYPE_LABEL[a['change_type']]}）仅含旧版段落、"
                    "新版无对应段落，义务判为移除")
                items.append(it)
            continue

        # ---- 拆分 / 合并 / 多段改写：禁止配对，全部待核验并展示候选 ----
        if not (len(ois) == 1 and len(nis) == 1):
            blocked = (
                f"该映射组为{GROUP_TYPE_LABEL[a['change_type']]}"
                f"（旧版 {len(ois)} 段 ↔ 新版 {len(nis)} 段），"
                "无法在组内建立 1:1 义务对应，禁止强行匹配，列为待核验；"
                "下列为组内对侧候选（按相似度排序），需人工确认")
            old_rank, new_rank = _rank(old_obs, new_obs, cache,
                                       allow_missing_subject=True)
            for i, o in enumerate(old_obs):
                it = _base_item(a)
                it["old"] = o
                it["verdict"] = "review"
                it["reason"] = blocked
                it["old_candidates"] = _candidate_list(
                    o, new_obs, old_rank[i], blocked_why=blocked)
                items.append(it)
            for j, n in enumerate(new_obs):
                it = _base_item(a)
                it["new"] = n
                it["verdict"] = "review"
                it["reason"] = blocked
                it["new_candidates"] = _candidate_list(
                    n, old_obs, new_rank[j], blocked_why=blocked)
                items.append(it)
            continue

        # ---- 1:1 组：双向互最佳贪心配对（两侧对次佳分差均超并列带才接受） ----
        old_rank, new_rank = _rank(old_obs, new_obs, cache)
        # 展示用排名：主体缺失时也按行为相似度列候选（仅供人工核验，绝不自动配对）
        disp_old_rank, disp_new_rank = _rank(
            old_obs, new_obs, cache, allow_missing_subject=True)
        paired_old: set[int] = set()
        paired_new: set[int] = set()

        def strong(rank, used):
            """剩余可达门槛候选，按综合分降序。"""
            return [(k, sc) for k, sc in rank if k not in used
                    and sc["score"] >= PAIR_GATE and sc["action_sim"] >= ACTION_GATE]

        while True:
            accepted = []
            for i in old_rank:
                if i in paired_old:
                    continue
                so = strong(old_rank[i], paired_new)
                if not so:
                    continue
                bj, bsc = so[0]
                if bj in paired_new:
                    continue
                # 旧义务侧：与次佳分差须 > 并列带，否则并列待核验
                if len(so) >= 2 and so[0][1]["score"] - so[1][1]["score"] <= TIE_BAND:
                    continue
                sn = strong(new_rank[bj], paired_old)
                # 新义务侧：i 必须是其互最佳，且与次佳分差同样 > 并列带
                if not sn or sn[0][0] != i:
                    continue
                if len(sn) >= 2 and sn[0][1]["score"] - sn[1][1]["score"] <= TIE_BAND:
                    continue
                accepted.append((i, bj, bsc))
            if not accepted:
                break
            for i, j, sc in accepted:
                paired_old.add(i)
                paired_new.add(j)
                o, n = old_obs[i], new_obs[j]
                verdict, reason = _verdict(o, n, sc)
                it = _base_item(a)
                it["old"], it["new"] = o, n
                it["subject_sim"], it["action_sim"], it["score"] = (
                    sc["subject_sim"], sc["action_sim"], sc["score"])
                it["verdict"] = verdict
                it["reason"] = reason
                items.append(it)

        # ---- 未配项对称分类：主体缺失 / 候选并列 → 待核验；否则 移除/新增 ----
        def leftovers(idx, rank, used, side_name):
            """返回 (tied_keys, strong_list)：并列各方键集合。"""
            sl = strong(rank, used)
            tied = set()
            if len(sl) >= 2 and sl[0][1]["score"] - sl[1][1]["score"] <= TIE_BAND:
                best = sl[0][1]["score"]
                tied = {k for k, sc in sl if best - sc["score"] <= TIE_BAND}
            return tied

        old_tie: dict[int, set[int]] = {}   # 旧义务 i 与之并列的新义务
        new_tie: dict[int, set[int]] = {}
        for i in old_rank:
            if i not in paired_old:
                old_tie[i] = leftovers(i, old_rank[i], paired_new, "新")
        for j in new_rank:
            if j not in paired_new:
                new_tie[j] = leftovers(j, new_rank[j], paired_old, "旧")

        def review_item(ob, a_, cands, why, field_name):
            it = _base_item(a_)
            if ob["side"] == "old":
                it["old"] = ob
            else:
                it["new"] = ob
            it["verdict"] = "review"
            it["reason"] = why
            it[field_name] = cands
            items.append(it)

        for i in old_rank:
            if i in paired_old:
                continue
            o = old_obs[i]
            avail = [(j, sc) for j, sc in old_rank[i] if j not in paired_new]
            disp_avail = [(j, sc) for j, sc in disp_old_rank[i] if j not in paired_new]
            if o["subject_missing"]:
                review_item(o, a, _candidate_list(o, new_obs, disp_avail),
                            "该义务未能提取到主体（主体缺失，禁止猜测），下列候选按行为相似度列出，仅供人工确认",
                            "old_candidates")
                continue
            if old_tie[i]:
                tied_rank = [(j, sc) for j, sc in avail if j in old_tie[i]]
                review_item(o, a, _candidate_list(o, new_obs, tied_rank),
                            ("组内存在多个相似度接近的并列新版义务"
                             "（最佳与次佳综合分差 ≤ %.0f%%），互最佳不唯一，禁止强行选取"
                             % (TIE_BAND * 100)),
                            "old_candidates")
                continue
            it = _base_item(a)
            it["old"] = o
            it["verdict"] = "removed"
            it["reason"] = (
                "组内无达配对门槛（综合 %.0f%%、行为 %.0f%%）的新版义务，判为移除，"
                "未跨组、未猜测配对；下列为最相近项" % (PAIR_GATE * 100, ACTION_GATE * 100))
            it["old_candidates"] = _candidate_list(o, new_obs, avail)
            items.append(it)

        for j in new_rank:
            if j in paired_new:
                continue
            n = new_obs[j]
            # 已作为旧侧并列候选列出的新义务，同样以待核验列出（带旧侧候选）
            in_old_tie = any(j in ts for ts in old_tie.values())
            avail = [(i, sc) for i, sc in new_rank[j] if i not in paired_old]
            disp_avail = [(i, sc) for i, sc in disp_new_rank[j] if i not in paired_old]
            if n["subject_missing"]:
                review_item(n, a, _candidate_list(n, old_obs, disp_avail),
                            "该义务未能提取到主体（主体缺失，禁止猜测），下列候选按行为相似度列出，仅供人工确认",
                            "new_candidates")
                continue
            if new_tie[j] or in_old_tie:
                strong_rank = [(i, sc) for i, sc in avail
                               if sc["score"] >= PAIR_GATE and sc["action_sim"] >= ACTION_GATE]
                review_item(n, a, _candidate_list(n, old_obs, strong_rank or avail),
                            ("组内存在多个相似度接近的并列旧版义务"
                             "（最佳与次佳综合分差 ≤ %.0f%%），互最佳不唯一，禁止强行选取"
                             % (TIE_BAND * 100)),
                            "new_candidates")
                continue
            it = _base_item(a)
            it["new"] = n
            it["verdict"] = "added"
            it["reason"] = (
                "组内无达配对门槛（综合 %.0f%%、行为 %.0f%%）的旧版义务，判为新增，"
                "未跨组、未猜测配对；下列为最相近项" % (PAIR_GATE * 100, ACTION_GATE * 100))
            it["new_candidates"] = _candidate_list(n, old_obs, avail)
            items.append(it)

    counts = {k: 0 for k in VERDICT_LABEL}
    for it in items:
        counts[it["verdict"]] += 1
    return {
        "items": items,
        "counts": counts,
        "total": len(items),
        "verdict_labels": VERDICT_LABEL,
        "modal_labels": MODAL_LABEL,
        "group_labels": GROUP_TYPE_LABEL,
        "rules": {
            "pair_gate": PAIR_GATE,
            "action_gate": ACTION_GATE,
            "subject_compat": SUBJ_COMPAT,
            "tie_band": TIE_BAND,
            "unchanged_action": UNCHANGED_ACTION,
            "weights": {"subject": PAIR_W_SUBJ, "action": PAIR_W_ACT},
        },
    }
