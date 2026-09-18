/* ══════════════════════════════════════════════════════════════
   harness.js —— 在本地把 concurrencyCheck 这个云函数跑起来

   ⚠️ 它【不能】替代真机那一次。云开发的事务到底怎么加锁、往一个不存在的
      文档上写算不算冲突 —— 那是云数据库的实现细节，任何假 db 都还原不出来。
      那正是第 0 步要去云上量的东西。

   它能做的是另一件事：**在花掉你一次真机往返之前，先把代码本身的毛病挑出来**。
      这段代码一次都没执行过，而它唯一的常规验证方式是「传到云上跑一次」——
      一个变量名打错，就得赔上你五分钟和一轮对话。（第一次写它时就有一个：
      naiveBook / txnBook 里引用了 DELAY，而那个变量只存在于 main 内部。）

   跑法：./dev/concurrency-check/run.sh

   两种模式，分别验 verdict 的两个方向：
     conflict —— 模仿 TCB 实测行为：提交时发现读过的文档版本变了就冲突，
                 **并且把冲突原样抛给调用方，不替它重试**（这是 2026-09-18
                 在真云上量到的；第一版台架替 SDK 重试了，是错的）
                 → 期望 verdict 说「成立」
     plain    —— 事务完全不做冲突检测（runTransaction 直接跑回调）
                 → 期望 verdict 说「不成立」
   第二种是给第一种做的【阴性对照】：如果连不做冲突检测的假 db 都报「成立」，
   那就说明 verdict 那段判断是假的，真机上无论看到什么都不能信。
   ══════════════════════════════════════════════════════════════ */

var IS_NODE = (typeof process !== 'undefined' && process.versions && process.versions.node);
if (IS_NODE) {
  var fs = require('fs');
  var readFile = function (p) { return fs.readFileSync(p, 'utf8'); };
  var print = function (s) { process.stdout.write(s + '\n'); };
}

var ROOT = '/Users/fanwei/Code/mini_program/';
var FN_PATH = ROOT + 'cloudfunctions/concurrencyCheck/index.js';

/* ── 假数据库 ───────────────────────────────────────────── */

function makeDb(mode) {
  var store = {};                                    // 集合名 → { _id → 文档 }
  var ver = {};                                      // "集合/_id" → 版本号
  var stats = { commits: 0, conflicts: 0, retries: 0 };

  var coll = function (c) { return (store[c] = store[c] || {}); };
  var key = function (c, id) { return c + '/' + id; };
  var tick = function (c, id) { ver[key(c, id)] = (ver[key(c, id)] || 0) + 1; };
  var clone = function (o) { return o === undefined ? o : JSON.parse(JSON.stringify(o)); };

  function notExist(op) {
    var e = new Error('document.' + op + ':fail document does not exist');
    e.errCode = -502004;
    return e;
  }

  /* 直接落库（事务外用） */
  function docRef(c, id) {
    return {
      get: function () {
        var d = coll(c)[id];
        if (d === undefined) throw notExist('get');
        return Promise.resolve({ data: clone(d) });
      },
      set: function (a) {
        coll(c)[id] = clone(a.data); tick(c, id);
        return Promise.resolve({});
      },
      update: function (a) {
        var d = coll(c)[id];
        if (d === undefined) throw notExist('update');
        Object.assign(d, clone(a.data)); tick(c, id);
        return Promise.resolve({ stats: { updated: 1 } });
      },
      remove: function () {
        var d = coll(c)[id];
        if (d === undefined) throw notExist('remove');
        delete coll(c)[id]; tick(c, id);
        return Promise.resolve({ stats: { removed: 1 } });
      },
    };
  }

  function collectionRef(c) {
    return {
      doc: function (id) { return docRef(c, id); },
      add: function (a) {
        var id = (a.data && a.data._id) || ('auto' + Math.random().toString(36).slice(2));
        if (coll(c)[id] !== undefined) {
          var e = new Error('document.add:fail duplicate key error');
          e.errCode = -502001; e.code = 'DUPLICATE_KEY';
          throw e;
        }
        coll(c)[id] = clone(a.data); tick(c, id);
        return Promise.resolve({ _id: id });
      },
      count: function () { return Promise.resolve({ total: Object.keys(coll(c)).length }); },
      where: function (q) {
        return {
          count: function () {
            var n = 0;
            Object.keys(coll(c)).forEach(function (id) {
              var d = coll(c)[id], hit = true;
              Object.keys(q || {}).forEach(function (k) { if (d[k] !== q[k]) hit = false; });
              if (hit) n++;
            });
            return Promise.resolve({ total: n });
          },
        };
      },
    };
  }

  /* 事务对象：读的时候记下版本，写只排队，提交时才落库 */
  function txnFor(rec) {
    return {
      collection: function (c) {
        return {
          doc: function (id) {
            return {
              get: function () {
                rec.reads.push({ c: c, id: id, v: ver[key(c, id)] || 0 });
                return docRef(c, id).get();
              },
              set: function (a) { rec.writes.push({ t: 'set', c: c, id: id, data: clone(a.data) }); return Promise.resolve({}); },
              update: function (a) { rec.writes.push({ t: 'update', c: c, id: id, data: clone(a.data) }); return Promise.resolve({}); },
              remove: function () { rec.writes.push({ t: 'remove', c: c, id: id }); return Promise.resolve({}); },
            };
          },
          add: function (a) {
            rec.writes.push({ t: 'add', c: c, data: clone(a.data) });
            return Promise.resolve({ _id: a.data && a.data._id });
          },
        };
      },
    };
  }

  /* 报错形状照抄真云上量到的那一条 —— 尤其 errCode 是 -501001 而不是
     什么 -502005，且 message 里带 [ResourceUnavailable.TransactionConflict]。
     照抄不是洁癖：被测的 isConflict() 【只看文本】，假 db 要是自己编一个
     好看的码，测出来的就是假绿。 */
  function conflictError() {
    var e = new Error('document.update:fail -501001 resource system error. '
      + '[ResourceUnavailable.TransactionConflict] Transaction is conflict, '
      + 'maybe resource operated by others.');
    e.errCode = -501001;
    return e;
  }

  function runOnce(fn, detect) {
    var rec = { reads: [], writes: [] };
    return Promise.resolve(fn(txnFor(rec))).then(function (ret) {
      /* 提交：读过的文档版本变了 → 冲突。必须先判再写，顺序反了就成了假绿 */
      if (detect) {
        var dirty = rec.reads.some(function (r) { return (ver[key(r.c, r.id)] || 0) !== r.v; });
        if (dirty) { stats.conflicts++; throw conflictError(); }
      }
      rec.writes.forEach(function (w) {
        if (w.t === 'remove') { delete coll(w.c)[w.id]; tick(w.c, w.id); return; }
        if (w.t === 'add') {
          var id = w.data && w.data._id;
          if (coll(w.c)[id] !== undefined) {
            var e = new Error('document.add:fail duplicate key error');
            e.errCode = -502001; throw e;
          }
          coll(w.c)[id] = w.data; tick(w.c, id); return;
        }
        if (w.t === 'set') { coll(w.c)[w.id] = w.data; tick(w.c, w.id); return; }
        var d = coll(w.c)[w.id];
        if (d === undefined) throw notExist('update');
        Object.assign(d, w.data); tick(w.c, w.id);
      });
      stats.commits++;
      return ret;
    });
  }

  return {
    collection: collectionRef,
    runTransaction: function (fn) {
      if (mode === 'plain') return runOnce(fn, false);
      /* ⚠️ 这里【故意】不重试。第一版台架自作主张地替 SDK 重试了，
         而 2026-09-18 在真云上量出来的是：**它不重试，冲突直接抛给调用方**
         （errCode -501001 / ResourceUnavailable.TransactionConflict）。
         那个多余的假设正好把本轮要测的东西遮住了 —— 重试环是【我们】写的，
         台架要验的是重试环自己能不能接住，所以这里必须原样抛出去。 */
      return runOnce(fn, true);
    },
    _stats: stats,
    _store: store,
  };
}

/* ── 加载云函数 ─────────────────────────────────────────── */

function loadFn(db) {
  var mockSdk = {
    init: function () {},
    database: function () { return db; },
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
  };
  var mockRequire = function (p) {
    if (p === 'wx-server-sdk') return mockSdk;
    if (p === 'wx-server-sdk/package.json') return { version: 'mock-0.0.0' };
    throw new Error('未预期的 require: ' + p);
  };
  var mod = { exports: {} };
  var fn = new Function('module', 'exports', 'require', readFile(FN_PATH));
  fn(mod, mod.exports, mockRequire);
  return mod.exports;
}

/* ── 断言 ──────────────────────────────────────────────── */

var passed = 0, failed = 0;
function ok(cond, label, got) {
  if (cond) { passed++; print('  ✓ ' + label); }
  else { failed++; print('  ✗ ' + label + '  (got ' + JSON.stringify(got) + ')'); }
}

/* ── 一个模式跑一遍 ─────────────────────────────────────── */

function run(mode, expectVerdict, done) {
  var db = makeDb(mode);
  var mod = loadFn(db);
  print('── 模式 ' + mode + ' ──────────────────────────');

  mod.main({}).then(function (rep) {
    var v = rep.verdict;
    var neg = rep.bursts[0], pos = rep.bursts[1];
    var exh = rep.bursts[2], stress = rep.bursts[3];

    ok(rep.collection && rep.collection.ok, '集合探针通过（没报「集合不存在」）', rep.collection && rep.collection.error);
    ok(rep.env.ok, 'env 探针没炸', rep.env.error);
    ok(rep.env.result && rep.env.result.hasRunTransaction === true, '认出 db.runTransaction', rep.env.result);
    ok(rep.probes.length === 4, '四个原语探针都跑了', rep.probes.length);
    ok(rep.probes.every(function (p) { return typeof p.ok === 'boolean'; }), '每个探针都给了明确成败');

    ok(neg.decidedFree >= 2, '阴性对照：无事务确实重复下单（台架造出了并发）', neg.decidedFree);
    ok(neg.threw === 0, '阴性对照：没有意外的抛错（有的话说明代码本身坏了）', neg.threwErrors);

    if (expectVerdict === '成立') {
      ok(pos.decidedFree === 1, '正题：事务只有一个赢家', pos.decidedFree);
      ok(pos.threw === 0, '正题：没人抛错 —— 冲突被重试环吃下了（这是本轮的核心）', pos.threwErrors);
      ok(pos.refusedTaken === pos.n - 1, '正题：其余全部是干净地被拒（不是超时、不是静默成功）', pos.refusedTaken);
      ok(Array.isArray(pos.persistedSlots) && pos.persistedSlots.length === 1, '正题：落库的持久状态也只有一个', pos.persistedSlots);
      ok(v.retrySawTaken === true, '输家重试后读到了赢家写的值（saw-free→saw-taken）', pos.callbackSaw);
      ok(v.posClean === true, 'posClean 三个条件都成立', { decided: pos.decidedFree, threw: pos.threw, refused: pos.refusedTaken });
      ok(v.conclusion.indexOf('成立') === 0, 'verdict 说「成立」', v.conclusion);

      ok(exh.threw === 0, '4 并发：也全部收干净（上一版这里 3 个抛错）', exh.threwErrors);
      ok(stress.threw === 0, '8 并发压力：也全部收干净', stress.threwErrors);
      ok(stress.decidedFree === 1, '8 并发压力：恰好一个赢家', stress.decidedFree);
      ok(stress.attempts.filter(function (a) { return a > 1; }).length > 0, '8 并发下重试环真的跑了（有人试了不止一次）', stress.attempts);
    } else {
      ok(pos.decidedFree > 1, '正题：无冲突检测时确实多人得手（阴性对照成立）', pos.decidedFree);
      ok(v.conclusion.indexOf('不成立') === 0, 'verdict 说「不成立」（它没有假绿）', v.conclusion);
    }

    ok(rep.leftBehind && rep.leftBehind.ok && rep.leftBehind.result === 0, '探针数据自己删干净了', rep.leftBehind && (rep.leftBehind.result || rep.leftBehind.error));
    ok(!/undefined|NaN/.test(JSON.stringify(v)), 'verdict 里没有 undefined/NaN');

    print('  → verdict: ' + v.conclusion);
    print('');
    done(rep);
  }).catch(function (e) {
    failed++;
    print('  ✗ 整份报告都没跑出来：' + (e && e.stack || e));
    print('');
    done(null);
  });
}

/* ══ 主流程 ══════════════════════════════════════════════
   ⚠️ 失败是【印出来】的，不是靠退出码。jsc 里未处理的 Promise 拒绝是
      静默 exit 0，quit(n) 也不改退出码 —— 所以这里绝不能把断言放在
      没有 catch 的异步链里，否则整套会「假装通过」。 */
print('══ concurrencyCheck 本地台架 ══════════════════════════');
print('（只验代码本身跑不跑得通；云数据库的事务语义只能在云上量）');
print('');

run('conflict', '成立', function () {
  run('plain', '不成立', function () {
    print('══════════════════════════════════════════════');
    print('  通过 ' + passed + ' / 失败 ' + failed);
    print('══════════════════════════════════════════════');
    if (failed > 0) print('!! 有失败 —— 别往云上传，先修代码');
  });
});
