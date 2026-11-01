export function createRouter() {
  const routes = [];

  function add(method, path, handler, options = {}) {
    const keys = [];
    const source = path.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
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
