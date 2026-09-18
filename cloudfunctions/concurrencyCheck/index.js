/* ══════════════════════════════════════════════════════════════
   concurrencyCheck —— 【临时】体检函数，第 0 步用

   它只回答一个问题：两个事务写同一个【已存在】的文档，到底会不会冲突。

   ── 第一轮（已跑完）的结论 ───────────────────────────────
   ① 会冲突。errCode -501001 / ResourceUnavailable.TransactionConflict。
      8 并发的阴性对照 8/8 全部得手（台架造出了真并发），
      2 并发的事务版落库恰好 1 条 —— 没有重复下单。地基成立。
   ② **但它不自动重试。** callbackRuns 全是 1，回调一次都没被重跑，
      冲突被直接抛给调用方。计划里赌的「runTransaction 自动重试」不存在。
   ③ 退路也成立：事务里对同一个 _id add 两次，第二次 E11000 duplicate key。
   ④ 时区是 UTC（tzOffsetMinutes 0），不是北京时间。
   ⑤ 探针 A1/A2 的 errCode 都是 -1 —— 判断「文档不存在」不能看 errCode。

   ── 第二轮（本版）只补最后一件事 ─────────────────────────
   手写的重试环能不能把那次冲突变成干净的「已被占」？
   预期：loser 的 callbackSaw 是 "saw-free→saw-taken"
   （回调真被重跑，且第二遍读到了赢家写下的值），threw 归零。

   它只碰 _id 以 "1900-01-01|" 开头的文档（形状和真的一模一样、内容
   明显是假的日期），跑完自己删干净。不读也不写任何真实订单。

   ⚠️ 验完必须从云上删掉：它没有任何鉴权、能往库里写东西。
      源码留在仓库里，要重跑再传一次。

   怎么跑：开发者工具 → 云开发 → 云函数 → concurrencyCheck → 测试 →
   传 {} 就行。返回一大坨 JSON，整份贴回来。

   可调（都通过 event 传）：{ delay: 500, negN: 8, posN: 2, exhN: 4 }
   —— 想先快速看一眼就传 {"delay": 0}。默认值是按「总耗时压在 3 秒内」
   调的，因为云函数默认超时就是 3 秒（超时的话什么都返回不了）。
   ══════════════════════════════════════════════════════════════ */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const COLL = 'occupancy';
const FAKE = '1900-01-01';   // 探针用的假日期：形状真实，内容一眼是假的
const SLOT = '1140';         // 被抢的那一格（分钟数，随便取的假值）
const idOf = i => `${FAKE}|${i}`;

/* 报错形状在云函数里不统一，能捞多少捞多少 —— 报错本身就是这次体检的产物 */
function errInfo(e) {
  let raw;
  try { raw = JSON.stringify(e); } catch (_) { raw = String(e); }
  return {
    message: e && e.message,
    errCode: e && e.errCode,
    code: e && e.code,
    name: e && e.name,
    raw,
  };
}

/* 每个探针单独 try/catch：一个塌了不能把整份报告带走 */
async function probe(fn) {
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    return { ok: false, error: errInfo(e) };
  }
}

const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

/* runTransaction 的返回值形状各版本不一样，两种都兜住 */
const unwrap = res => (res && typeof res === 'object' && 'result' in res ? res.result : res);

/* ── 探针文档的建与删 ───────────────────────────────────── */

/** 建一个探针文档；已经存在也算成功（ensure 语义） */
async function ensureDoc(id) {
  try {
    await db.collection(COLL).add({ data: { _id: id, slots: {}, probe: true } });
    return 'created';
  } catch (e) {
    return 'already(' + (e.errCode || e.code || e.message) + ')';
  }
}

/** 只删自己建的那些 id —— 不写 where，免得误伤真实数据 */
async function cleanup(ids) {
  const done = [];
  for (const id of ids) {
    const r = await probe(() => db.collection(COLL).doc(id).remove());
    done.push(id + (r.ok ? '' : ' ✗'));
  }
  return done;
}

/* ── 两条下单路径：唯一的差别就是有没有事务 ──────────────── */

/**
 * 朴素版：【没有事务】。先读占用、判空、再写。
 * 这就是要证伪的那条路 —— 它应该会重复下单。重复不了就说明
 * 这个测试环境根本没产生真并发，后面所有的「通过」都是假的。
 */
async function naiveBook(docId, marker, log, delay) {
  const ref = db.collection(COLL).doc(docId);
  const cur = await ref.get();
  const slots = (cur.data && cur.data.slots) || {};
  log.push(slots[SLOT] ? 'saw-taken' : 'saw-free');
  if (slots[SLOT]) return { booked: false, why: 'taken', marker: null };

  await sleep(delay);
  /* 整张 slots 写回去（不是点号路径）—— 这正是真实设计里的读-改-写，
     也是失去更新的经典形状。 */
  await ref.update({ data: { slots: Object.assign({}, slots, { [SLOT]: marker }) } });
  return { booked: true, why: 'wrote', marker };
}

/** 事务版：读、判空、写全在 runTransaction 里 */
async function txnBook(docId, marker, log, delay) {
  const res = await db.runTransaction(async transaction => {
    const doc = await transaction.collection(COLL).doc(docId).get();
    const slots = (doc.data && doc.data.slots) || {};

    /* 记下「这一趟回调看到了什么」。回调若被重跑，这里会追加第二条 ——
       那正是「重试会不会重读」的证据。 */
    log.push(slots[SLOT] ? 'saw-taken' : 'saw-free');
    if (slots[SLOT]) return { booked: false, why: 'taken', marker: null };

    await sleep(delay);
    await transaction.collection(COLL).doc(docId)
      .update({ data: { slots: Object.assign({}, slots, { [SLOT]: marker }) } });
    return { booked: true, why: 'wrote', marker };
  });
  return unwrap(res);
}

/* ── 自己写的重试环 ─────────────────────────────────────────
   存在的理由就是第一轮那个意外：runTransaction 不替我们重试。

   ⚠️ 判据【只看报错文本，不看 errCode】—— 这是有实测依据的：
      同一个 errCode -1 既出现在「文档不存在」（A1/A2），也出现在别处；
      而冲突是 -501001，那个码官方描述是笼统的 "resource system error"，
      将来别的资源错误也可能落进来。文本里的 TransactionConflict
      是唯一说得准的东西。

   代价说清楚：万一官方改了那句文案，重试环会认不出来 —— 那时它会
   **直接抛出去**（调用方看到失败），而不是悄悄少重试一次。这是故意的：
   响亮地坏，好过安静地坏。 */
const CONFLICT_RE = /TransactionConflict|TRANSACTION_CONFLICT/;
function isConflict(e) {
  if (!e) return false;
  const text = [e.message, e.errMsg, e.raw].filter(Boolean).join(' ');
  return CONFLICT_RE.test(text);
}

const RETRY_TRIES = 4;

/**
 * 事务 + 退避重试。这就是未来 createBooking 里的形状。
 *
 * 为什么重试能得出「已被占」而不是死循环：输的那一方什么都没提交，
 * 重试时是一个全新的快照 —— 那时赢家已经落库，get 会读到它写的值，
 * 于是走「已被占」分支直接返回。**关键是要等赢家提交**，所以退避里
 * 必须带抖动：几个人同时重试、又都没等到赢家提交的话，会反复撞在一起。
 */
async function retryBook(docId, marker, log, delay) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await txnBook(docId, marker, log, delay);
      return Object.assign({}, r, { attempts: attempt });
    } catch (e) {
      if (!isConflict(e) || attempt >= RETRY_TRIES) {
        e.attempts = attempt;
        throw e;
      }
      await sleep(30 + Math.floor(Math.random() * 70));
    }
  }
}

/* ── 并发台架 ───────────────────────────────────────────── */

/**
 * 同时发 N 发，全部打同一格。返回的每一个数字都要能对上账：
 * decided = ok 且判空成功的人数（「重复下单」就是它 > 1）
 * threw   = 抛出来的人数（重试耗尽会落这里）
 * 最后再【读回持久状态】—— 绝不能拿事务的返回值当唯一依据：
 * 一个返回成功却什么都没写的事务，正是这个设计活不下来的那种失败。
 */
async function burst(label, docId, book, n, delay) {
  await probe(() => db.collection(COLL).doc(docId).remove());   // 先清成空的
  const ensured = await ensureDoc(docId);

  const logs = [];
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const log = [];
    logs.push(log);
    tasks.push(
      book(docId, 'M' + i, log, delay)
        .then(r => ({ ok: true, r }))
        .catch(e => ({ ok: false, e: errInfo(e) }))
    );
  }

  const t0 = Date.now();
  const settled = await Promise.all(tasks);
  const ms = Date.now() - t0;

  const decided = settled.filter(s => s.ok && s.r && s.r.booked);
  const refused = settled.filter(s => s.ok && s.r && !s.r.booked);
  const threw = settled.filter(s => !s.ok);

  /* 提交之后读回来看到底写进去了什么 */
  const after = await probe(async () => {
    const cur = await db.collection(COLL).doc(docId).get();
    return Object.keys((cur.data && cur.data.slots) || {});
  });

  return {
    label,
    docId,
    ensured,
    n,
    delayMs: delay,
    elapsedMs: ms,
    decidedFree: decided.length,                 // ← 重复下单数
    refusedTaken: refused.length,
    threw: threw.length,
    threwErrors: threw.slice(0, 3).map(s => s.e),
    callbackRuns: logs.map(l => l.length),       // 每条 ≥2 说明事务被重跑了
    callbackSaw: logs.map(l => l.join('→')),     // 期待输家出现 saw-free→saw-taken
    attempts: settled.map(s => (s.ok && s.r && s.r.attempts) || (s.e && s.e.attempts) || 0),
    persistedSlots: after.ok ? after.result : after.error,   // ← 权威事实
    markers: decided.map(s => s.r.marker || null).filter(Boolean),
  };
}

/* ── 主流程 ─────────────────────────────────────────────── */

exports.main = async (event = {}) => {
  const delay = event.delay === undefined ? 500 : event.delay;
  const negN = event.negN === undefined ? 8 : event.negN;
  const posN = event.posN === undefined ? 2 : event.posN;
  const exhN = event.exhN === undefined ? 4 : event.exhN;
  const stressN = event.stressN === undefined ? 8 : event.stressN;

  const report = { env: {}, probes: [], bursts: [], notes: [] };

  /* ① 运行时环境 —— 时区那条特别重要：云函数默认时区很可能不是
        Asia/Shanghai，而「取今天」错一天正好砸在订当晚场地的时段上 */
  report.env = await probe(async () => {
    let sdk = 'unknown';
    try { sdk = require('wx-server-sdk/package.json').version; } catch (_) {}
    let tz = 'unknown';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) {}
    return {
      sdkVersion: sdk,
      nodeVersion: (typeof process !== 'undefined' && process.version) || 'unknown',
      dateToString: new Date().toString(),
      iso: new Date().toISOString(),
      timezone: tz,
      tzOffsetMinutes: new Date().getTimezoneOffset(),   // -480 = UTC+8
      hasRunTransaction: typeof db.runTransaction === 'function',
    };
  });

  /* ①′ 最可能的翻车方式其实是「集合还没建」—— 手动建的，忘了就什么都没有。
        不单独查一下的话，它会表现成后面一长串看不懂的报错。 */
  report.collection = await probe(async () => {
    const r = await db.collection(COLL).count();
    return { name: COLL, total: r.total, exists: true };
  });
  if (!report.collection.ok) {
    report.notes.push(
      `集合 ${COLL} 读不到 —— 大概率是还没建。云开发控制台 → 数据库 → 新建集合，`
      + '名字必须是 occupancy（手动建，现在官方不自动建了）。'
      + '建完重跑本函数，别的都不用管。'
    );
  }

  /* ② 原语探针：先摸清楚手上有哪些牌，再去谈并发 */
  report.probes.push({
    name: 'A1 事务外 get 一个不存在的 doc',
    ...await probe(async () =>
      (await db.collection(COLL).doc(idOf(0)).get()).data),
  });

  report.probes.push({
    name: 'A2 事务内 get 一个不存在的 doc',
    ...await probe(async () => {
      const r = await db.runTransaction(async t =>
        (await t.collection(COLL).doc(idOf(0)).get()).data);
      return unwrap(r);
    }),
  });

  report.probes.push({
    name: 'A3 事务内 set 一个不存在的 doc，提交后读回来还在不在',
    ...await probe(async () => {
      const id = idOf(1);
      await probe(() => db.collection(COLL).doc(id).remove());
      await db.runTransaction(async t => {
        // set 是整文档替换（不是 update 的那种局部改）
        await t.collection(COLL).doc(id).set({ data: { slots: { '1': 'SET' }, probe: true } });
      });
      const back = await db.collection(COLL).doc(id).get();
      return { afterCommit: back.data };
    }),
  });

  report.probes.push({
    name: 'A4 事务内 add 一个指定 _id 的 doc，连做两次',
    ...await probe(async () => {
      const id = idOf(2);
      await probe(() => db.collection(COLL).doc(id).remove());
      const first = await probe(async () => {
        await db.runTransaction(async t => {
          await t.collection(COLL).add({ data: { _id: id, slots: {}, probe: true } });
        });
        return 'accepted';
      });
      const second = await probe(async () => {
        await db.runTransaction(async t => {
          await t.collection(COLL).add({ data: { _id: id, slots: {}, probe: true } });
        });
        return 'accepted-AGAIN(唯一性没生效?)';
      });
      return { first, second };
    }),
  });

  /* ③ 【阴性对照】没有事务的朴素版。这一段必须先跑，而且必须先看到
        重复下单 —— 看不到就说明台架根本没造出并发，后面全不作数。 */
  report.bursts.push(await burst(
    '阴性对照：无事务（应当看到重复下单）', idOf(6),
    naiveBook, negN, Math.min(delay, 200)
  ));

  /* ④ 【正题】两个事务抢同一个【已存在】的文档，这次带上自写的重试环。
        要看到的是：输家重试后读到赢家的值，走「已被占」，
        rather than 把冲突抛给调用方。 */
  report.bursts.push(await burst(
    '正题：事务 + 自写重试环，2 并发', idOf(7),
    retryBook, posN, delay
  ));

  /* ⑤ 拉高并发：4 个人抢。上一轮这里 3 个抛错，现在应当全部变成「被拒」 */
  report.bursts.push(await burst(
    '重试环：4 并发（上一轮 3 个抛错）', idOf(8),
    retryBook, exhN, Math.min(delay, 300)
  ));

  /* ⑥ 压力：8 个人抢，退避窗口压短到 100ms —— 逼重试环真的跑起来，
        而不是每次都在赢家提交之后才醒。 */
  report.bursts.push(await burst(
    '压力：事务 + 重试环，8 并发', idOf(9),
    retryBook, stressN, Math.min(delay, 100)
  ));

  /* ⑥ 收摊：把探针文档全删掉，并把删完还剩什么如实报出来 */
  report.cleanup = await cleanup([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(idOf));
  report.leftBehind = await probe(async () => {
    const r = await db.collection(COLL).where({ probe: true }).count();
    return r.total;
  });

  /* ⑦ 结论 —— 这一段必须写。不写的话，「挡住了」和「压根没测到」在报告里
        长得一模一样：比如 runTransaction 不存在时四次全抛，decidedFree 也是 0，
        看着就像「没有重复下单」。所以每一条都先问「这个测试真的跑起来了吗」，
        跑不起来就报【不确定】，绝不报通过。 */
  const [neg, pos, exh, stress] = report.bursts;

  /* 单独问一次 runTransaction 在不在 —— 【不要】用「env 探针整体成功了吗」来判断。
     那两件事无关，捆在一起的话，env 里任何一行无关紧要的代码炸了
     （实测过：jsc 里没有 process），整个结论就被拖成「不确定」，
     而真正要看的并发结果明明已经拿到了。 */
  const hasTxn = typeof db.runTransaction === 'function';

  const negProvesConcurrency = neg.decidedFree >= 2;

  /* 输家重试后【读到了赢家写的值】—— 这是本轮唯一要证的东西。
     "saw-taken" 出现在 callbackSaw 里，说明回调被重跑过、且第二遍
     get 到的是新值；只要这条成立，「拒绝」就是真的判出来的，
     不是超时/兜底碰巧得到的。 */
  const retrySawTaken = pos.callbackSaw.some(s => /saw-taken/.test(s));
  const posPersistedOne = Array.isArray(pos.persistedSlots) && pos.persistedSlots.length === 1;
  const posClean = pos.decidedFree === 1 && pos.threw === 0 && pos.refusedTaken === pos.n - 1;

  let conclusion;
  if (!report.collection.ok) {
    conclusion = `不确定：集合 ${COLL} 不存在或读不到 —— 先把集合建出来再看别的`;
  } else if (!hasTxn) {
    conclusion = '不确定：这个版本的 SDK 里没有 db.runTransaction，事务方案无从谈起';
  } else if (!negProvesConcurrency) {
    conclusion = `不确定：阴性对照【没有】出现重复下单（${neg.decidedFree}/${neg.n}）——`
      + '说明台架根本没造出真并发，后面所有数字都不作数，先调大 delay 重跑';
  } else if (posClean && retrySawTaken && posPersistedOne) {
    conclusion = '成立：事务 + 自写重试环。输家重试后读到了赢家的值、走「已被占」干净退场，'
      + '落库恰好 1 条。地基可以用';
  } else if (pos.threw > 0) {
    conclusion = `不确定：带上重试环后仍有 ${pos.threw} 次抛错 ——`
      + '要么退避窗口不够（重试时赢家还没提交），要么冲突不是靠文本能认出来的那个形状。看 threwErrors';
  } else if (retrySawTaken && pos.decidedFree === 1) {
    conclusion = '部分成立：拒绝是真判出来的，但落库状态对不上（' + JSON.stringify(pos.persistedSlots) + '）'
      + ' —— 事务返回值与持久状态不一致，这正是最危险的那种失败，继续查';
  } else {
    conclusion = `不成立：事务版有 ${pos.decidedFree} 个赢家 —— 地基不成立，换退路`;
  }

  report.verdict = {
    hasTxn,
    envOk: report.env.ok,
    negProvesConcurrency,
    posClean,
    retrySawTaken,
    posPersistedOne,
    conclusion,
    negControl: `无事务 ${neg.decidedFree}/${neg.n} 个判空成功（>1 才算真并发）`,
    positive: `事务+重试 ${pos.decidedFree} 成功 / ${pos.refusedTaken} 被拒 / ${pos.threw} 抛错，`
      + `落库 ${JSON.stringify(pos.persistedSlots)}，回调 ${JSON.stringify(pos.callbackSaw)}`,
    exhausted: `${exh.decidedFree} 成功 / ${exh.refusedTaken} 被拒 / ${exh.threw} 抛错，`
      + `重试次数 ${JSON.stringify(exh.attempts)}`,
    stress: `${stress.decidedFree} 成功 / ${stress.refusedTaken} 被拒 / ${stress.threw} 抛错，`
      + `重试次数 ${JSON.stringify(stress.attempts)}`,
    retryNote: retrySawTaken
      ? '观察到输家重试后读到 saw-taken → 重试确实重新读，不是空转'
      : '没观察到 saw-taken → 输家一次就成功了？还是重试读到旧值？看 callbackSaw',
    timezoneNote: 'tzOffsetMinutes=' + (report.env.ok && report.env.result
      ? report.env.result.tzOffsetMinutes : 'unknown'),
  };
  return report;
};
