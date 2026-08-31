"use strict";
// moment 的最小替身。
//
// 为什么不装 moment: main.js 只用到它的两件事——
//   ① renderPath(): momentLib(dateStr, "YYYY-MM-DD").format(pathFormat) / .locale("en").format(...)
//   ② renderTemplate(): momentLib(dateStr,"YYYY-MM-DD").format(fmt) 与 momentLib(now).format("HH:mm")
// 支持这些令牌不需要 300KB 依赖, 且少一个依赖就少一处版本漂移。
//
// 与 tests/bindtest.js 里的 momentStub 同源(同一张令牌表、同一条贪心正则), 差别只有两处:
//   · 这里的 now 走配置时区(Asia/Shanghai), 桩走宿主本地时间
//   · 这里实现 .locale(), 桩没有(main.js 对无 locale 的实现有兜底分支)
// 白名单外的英文字母输出 "?" —— 与桩一致, 让"Assets 忘了加方括号"在服务端也炸得出来。

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// [..] 字面量 | 令牌(同一字母长的在前 = 贪心) | 其它英文字母 | 任意单字符
const TOKEN_RE = /(\[[^\[]*\])|(YYYY|YY|MMMM|MMM|MM|M|DDDD|DDD|DD|D|dddd|ddd|dd|d|E|e|ww|w|Q|HH|H|mm|m|ss|s|A|a)|([A-Za-z])|([\s\S])/g;

let _tz = "Asia/Shanghai";
function setTimezone(tz) {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); _tz = tz; }
  catch (e) { _tz = "Asia/Shanghai"; }
}

// 把一个 Date 在指定时区下拆成年月日时分秒(不依赖宿主本地时区)
const _partsFmtCache = new Map();
function partsInTz(date, tz) {
  let f = _partsFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    _partsFmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(date)) if (p.type !== "literal") o[p.type] = p.value;
  return {
    y: +o.year, mo: +o.month, d: +o.day,
    h: +(o.hour === "24" ? "0" : o.hour), mi: +o.minute, s: +o.second,
  };
}

function pad(n, w) { return String(n).padStart(w, "0"); }

class MomentLite {
  constructor(parts, locale) {
    this._p = parts;
    this._locale = locale || null;
  }

  locale(name) {
    // 只区分"固定 en"与"跟随宿主": 服务端没有界面语言, 两者输出相同。
    // 实现它是为了让 main.js 走 `typeof m.locale === "function"` 那条分支(与 Obsidian 侧同路径)。
    return new MomentLite(this._p, name || "en");
  }

  format(fmt) {
    const p = this._p;
    const dow = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
    const doy = Math.round((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(p.y, 0, 1)) / 86400000) + 1;
    const jan1Dow = new Date(Date.UTC(p.y, 0, 1)).getUTCDay();
    const week = Math.floor((doy - 1 + jan1Dow) / 7) + 1;  // en 地区: 周日起, 含 1/1 的那周为第 1 周
    const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
    const token = (t) => {
      switch (t) {
        case "YYYY": return pad(p.y, 4);
        case "YY": return pad(p.y % 100, 2);
        case "M": return String(p.mo);
        case "MM": return pad(p.mo, 2);
        case "MMM": return MONTHS[p.mo - 1].slice(0, 3);
        case "MMMM": return MONTHS[p.mo - 1];
        case "D": return String(p.d);
        case "DD": return pad(p.d, 2);
        case "DDD": return String(doy);
        case "DDDD": return pad(doy, 3);
        case "d": return String(dow);
        case "dd": return DAYS[dow].slice(0, 2);
        case "ddd": return DAYS[dow].slice(0, 3);
        case "dddd": return DAYS[dow];
        case "E": return String(dow === 0 ? 7 : dow);
        case "e": return String(dow);
        case "w": return String(week);
        case "ww": return pad(week, 2);
        case "Q": return String(Math.floor((p.mo - 1) / 3) + 1);
        case "HH": return pad(p.h, 2);
        case "H": return String(p.h);
        case "mm": return pad(p.mi, 2);
        case "m": return String(p.mi);
        case "ss": return pad(p.s, 2);
        case "s": return String(p.s);
        case "A": return p.h < 12 ? "AM" : "PM";
        case "a": return p.h < 12 ? "am" : "pm";
        default: return t;
      }
    };
    const fs = fmt == null ? "YYYY-MM-DD[T]HH:mm:ss" : String(fmt);
    return fs.replace(TOKEN_RE, (m, lit, tok, letter, other) => {
      if (lit) return lit.slice(1, -1);
      if (tok) return token(tok);
      if (letter) return "?";       // 白名单外的字母: 与测试桩同款, 让漏加方括号炸出来
      return other;
    });
  }
}

// moment(input, inputFormat)
//   input 是 "YYYY-MM-DD" 串 → 当日历日处理(不带时刻, 与 moment 解析日期串同义)
//   input 是 Date / 省略      → 按配置时区拆解"此刻"
function momentLite(input, inputFmt) {
  if (input instanceof Date) return new MomentLite(partsInTz(input, _tz));
  if (input == null) return new MomentLite(partsInTz(new Date(), _tz));
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(input));
  if (!m) throw new Error("moment-lite: 不认识的输入 " + String(input));
  return new MomentLite({
    y: +m[1], mo: +m[2], d: +m[3],
    h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0, s: m[6] ? +m[6] : 0,
  });
}

momentLite.setTimezone = setTimezone;

module.exports = momentLite;
