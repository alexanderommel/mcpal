// Mock mode only: preloaded into the official PayPal MCP process so its HTTP calls hit the local mock PayPal.
const Module = require('module');
const base = process.env.PAYPAL_API_BASE;
const rx = /^https:\/\/api(-m)?(\.sandbox)?\.paypal\.com/;
const origLoad = Module._load;
const done = new WeakSet();
Module._load = function (request) {
  const m = origLoad.apply(this, arguments);
  if (base && /(^|\/)axios(\/|$)/.test(request) && m) {
    const ax = m.default || m;
    const proto = ax && ax.Axios && ax.Axios.prototype;
    if (proto && !done.has(proto)) {
      done.add(proto);
      const orig = proto.request;
      proto.request = function (cfgOrUrl, cfg) {
        if (typeof cfgOrUrl === 'string') {
          cfg = cfg || {};
          cfg.url = cfgOrUrl.replace(rx, base);
          return orig.call(this, cfg);
        }
        const c = cfgOrUrl || {};
        if (c.url) c.url = c.url.replace(rx, base);
        if (c.baseURL) c.baseURL = c.baseURL.replace(rx, base);
        return orig.call(this, c);
      };
    }
  }
  return m;
};
