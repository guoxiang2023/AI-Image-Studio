export function createRouter() {
  const routes = [];

  function add(method, path, handler, options = {}) {
    const keys = [];
    // A trailing `*` is a catch-all for the rest of the path, including `/`.
    // Relative references inside a served HTML file need directory-shaped URLs
    // (`.../files/sub/page.html` + `style.css`), which `:param` cannot express.
    const source = path
      .replace(/\/\*$/, '/(.*)')
      .replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      });
    if (path.endsWith('/*')) keys.push('rest');
    routes.push({
      method,
      regex: new RegExp(`^${source}$`),
      keys,
      handler,
      public: Boolean(options.public),
    });
  }

  return {
    get(path, handler, options) {
      add('GET', path, handler, options);
    },
    post(path, handler, options) {
      add('POST', path, handler, options);
    },
    put(path, handler, options) {
      add('PUT', path, handler, options);
    },
    patch(path, handler, options) {
      add('PATCH', path, handler, options);
    },
    delete(path, handler, options) {
      add('DELETE', path, handler, options);
    },
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const match = route.regex.exec(pathname);
        if (!match) continue;
        const params = {};
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(match[index + 1]);
        });
        return { route, params };
      }
      return null;
    },
  };
}
