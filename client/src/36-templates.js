/**
 * 本地模板生成器 — offline, free, and deterministic.
 *
 * The model path is good at flavour and bad at being free, instant, and
 * repeatable. This is the other tool: composing names and values from tables,
 * which is what "randomly generate an item" usually means for a novelist who
 * wants twenty plausible names to choose between rather than one paragraph of
 * prose.
 *
 * Everything here is a pure function of a seed, so a generation is reproducible
 * and the suite can assert on it. `makeRng` is seeded per click, not per session,
 * so consecutive clicks differ.
 *
 * The tables ARE the "database" — edit them directly, or see README for the
 * planned per-project override.
 */

/** mulberry32: small, fast, and good enough for picking names. */
function makeRng(seed) {
  let state = (Number(seed) >>> 0) || 1
  // Guard against a seeded zero producing a constant stream.
  if (state === 0) state = 0x9e3779b9
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One entry at random. */
function pick(rng, list) {
  // The tables are documented as directly editable, so an EMPTIED table is reachable.
  // Returning undefined interpolated the word "undefined" into a generated name.
  if (!Array.isArray(list) || list.length === 0) return ''
  return list[Math.floor(rng() * list.length) % list.length]
}

/** `count` distinct entries, or as many as the list holds. */
function pickSome(rng, list, count) {
  const pool = [...list]
  const out = []
  while (out.length < count && pool.length > 0) {
    out.push(pool.splice(Math.floor(rng() * pool.length) % pool.length, 1)[0])
  }
  return out
}

/** An integer in `[min, max]`. */
function pickInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1))
}

const TABLES = {
  surname: ['李', '王', '顾', '沈', '裴', '萧', '谢', '陆', '苏', '韩', '崔', '秦', '柳', '孟', '姜', '慕容', '上官', '独孤', '南宫', '司徒'],
  givenMale: ['渊', '邈', '峥', '玄', '霖', '珩', '彦', '晏', '衍', '宸', '砚', '舟', '尘', '策', '铮', '朔', '岐', '琅'],
  givenFemale: ['霜', '宁', '棠', '筝', '绾', '婳', '昭', '珺', '漪', '菱', '若', '莞', '岚', '笺', '绫', '蘅'],
  givenTail: ['之', '卿', '生', '客', '子', '君', '翁', '娘', '郎'],
  placePrefix: ['青云', '寒鸦', '碧水', '落霞', '苍梧', '玄冰', '断魂', '望川', '孤山', '赤霄', '白帝', '枯荣', '照影', '暮云', '碎星', '沉钟'],
  placeSuffix: ['城', '关', '谷', '潭', '峰', '宗', '门', '驿', '渡', '原', '林', '窟', '海', '台', '川', '渊'],
  orgPrefix: ['天', '玄', '青', '赤', '九', '太', '幽', '灵', '苍', '寒', '白', '无'],
  orgMid: ['云', '霄', '墟', '冥', '阳', '阴', '极', '元', '华', '清', '寂', '照'],
  orgSuffix: ['宗', '门', '殿', '阁', '盟', '会', '谷', '教', '楼', '堂', '府', '司'],
  itemMaterial: ['玄铁', '寒玉', '赤铜', '乌木', '霜晶', '龙骨', '雷击木', '沉银'],
  itemForm: ['剑', '刀', '枪', '镜', '灯', '印', '铃', '扇', '鼎', '幡', '琴', '笔'],
  itemQualifier: ['霜啼', '照雪', '断虹', '沉渊', '残夜', '离尘', '不周', '青冥', '照影', '碎星', '无咎', '重华'],
  rarity: ['凡品', '灵品', '玄品', '地阶', '天阶', '神品'],
  placeKind: ['城池', '山门', '秘境', '渡口', '关隘', '废墟', '洞天'],
  orgKind: ['宗门', '王朝', '商会', '义军', '世家', '教派'],
  eventVerb: ['倒戈', '围城', '失守', '缔约', '叛离', '登位', '屠戮', '封禅', '沉没', '开山'],
  eventNoun: ['寒鸦关', '青云宗', '北境', '雁回关', '落日原', '王城', '寒潭', '旧盟', '长夜'],
}

/** A name that is not already in use, if one can be found quickly. */
function novelName(rng, taken, build) {
  const used = new Set(taken ?? [])
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const name = build()
    if (!used.has(name)) return name
  }
  // Better a duplicate than an infinite loop; the author can rename.
  return build()
}

/** 姓 + 名, one or two characters. */
function personName(rng, taken) {
  return novelName(rng, taken, () => {
    const surname = pick(rng, TABLES.surname)
    const pool = rng() < 0.5 ? TABLES.givenMale : TABLES.givenFemale
    let given
    if (rng() < 0.35) {
      given = pick(rng, TABLES.givenTail)
    } else if (rng() < 0.4) {
      // A two-character given name must not repeat a character: 萧朔朔 is not a
      // name, it is a bug the author would have to notice and fix.
      const [first, second] = pickSome(rng, pool, 2)
      given = second === undefined ? first : `${first}${second}`
    } else {
      given = pick(rng, pool)
    }
    return `${surname}${given}`
  })
}

/** A place name: prefix + suffix, with an occasional 之 in between. */
function placeName(rng, taken) {
  return novelName(rng, taken, () => {
    const prefix = pick(rng, TABLES.placePrefix)
    const suffix = pick(rng, TABLES.placeSuffix)
    return rng() < 0.25 ? `${prefix}之${suffix}` : `${prefix}${suffix}`
  })
}

/** An organization name: prefix + middle + suffix. */
function orgName(rng, taken) {
  return novelName(rng, taken, () => {
    const prefix = pick(rng, TABLES.orgPrefix)
    const mid = rng() < 0.6 ? pick(rng, TABLES.orgMid) : ''
    return `${prefix}${mid}${pick(rng, TABLES.orgSuffix)}`
  })
}

/** An event title: noun + verb, e.g. 寒鸦关倒戈. */
function eventTitle(rng, taken) {
  return novelName(rng, taken, () => `${pick(rng, TABLES.eventNoun)}${pick(rng, TABLES.eventVerb)}`)
}

/**
 * An item draft whose parts agree with each other.
 *
 * The form (剑/灯/印) is chosen ONCE and used for the name, the 器型 attribute, and
 * the tag. Picking it independently in each place produced items like 「重华剑」
 * with 器型 灯 and tag 印 — three fields contradicting each other in one draft.
 *
 * This does not use `novelName`: deciding 材质 outside the retry meant the
 * material-named branch returned the same string on every attempt, so a taken name
 * was "retried" twelve times identically and then accepted. The material has to be
 * re-picked per attempt AND be the one the name actually uses, which is a coupled
 * constraint the shared helper cannot express.
 */
function itemDraft(rng, taken) {
  const form = pick(rng, TABLES.itemForm)
  const used = new Set(taken ?? [])
  let material = pick(rng, TABLES.itemMaterial)
  let name = ''
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (rng() < 0.5) {
      name = `${pick(rng, TABLES.itemQualifier)}${form}`
    } else {
      material = pick(rng, TABLES.itemMaterial)
      name = `${material}${form}`
    }
    if (!used.has(name)) break
  }
  return {
    name,
    rarity: pick(rng, TABLES.rarity),
    attrs: { 材质: material, 器型: form },
    tags: [form],
  }
}

/**
 * A draft entity of `kind` filled from the tables.
 *
 * Only the fields the local tables can honestly fill: prose fields (外貌, 性格,
 * 影响) are deliberately left as the author's own, because a template cannot write
 * them without pretending to be the model. The value of this path is names and
 * classifications, not description.
 */
function generateLocalDraft(kind, rng, options = {}) {
  const taken = Array.isArray(options.taken) ? options.taken : []

  if (kind === 'item') return itemDraft(rng, taken)
  if (kind === 'character') {
    return {
      name: personName(rng, taken),
      gender: rng() < 0.5 ? '男' : '女',
      // 人类 weighted, because a novel's cast usually is; the tables are meant to
      // be edited to match the author's world.
      race: pick(rng, ['人类', '人类', '人类', '妖族', '灵族']),
      ageNote: `${pickInt(rng, 16, 70)} 岁上下`,
      tags: pickSome(rng, ['老成', '孤僻', '果决', '温和', '多疑', '重诺', '悍勇', '沉稳'], 2),
    }
  }
  if (kind === 'place') {
    return {
      name: placeName(rng, taken),
      kind: pick(rng, TABLES.placeKind),
      tags: pickSome(rng, ['险要', '幽深', '荒废', '繁华', '苦寒', '灵脉'], 2),
    }
  }
  if (kind === 'organization') {
    return {
      name: orgName(rng, taken),
      kind: pick(rng, TABLES.orgKind),
      founded: { year: pickInt(rng, 1, 900), month: null, day: null },
      tags: pickSome(rng, ['尚武', '重商', '隐秘', '古老', '新兴', '正统'], 2),
    }
  }
  if (kind === 'timeline-event') {
    return {
      title: eventTitle(rng, taken),
      at: { year: pickInt(rng, options.minYear ?? 1, options.maxYear ?? 1000), month: pickInt(rng, 1, 12), day: null },
      spanEnd: null,
      atLabel: '',
    }
  }
  return {}
}

/** Whether a kind has a local generator. Mirrors the host's generator table. */
const LOCAL_KINDS = ['item', 'character', 'place', 'organization', 'timeline-event']
