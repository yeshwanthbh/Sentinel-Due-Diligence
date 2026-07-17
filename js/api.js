/* Sentinel DD — API client
 * Thin wrapper over the Cloudflare Worker API (worker/index.js). All calls are
 * same-origin and rely on the HttpOnly session cookie (credentials: "include"),
 * so no token handling happens in JS. Every module that used to read/write
 * IndexedDB now goes through window.DD.api. */
(function () {
  const DD = (window.DD = window.DD || {});

  async function req(method, path, body) {
    const init = { method, credentials: "include", headers: {} };
    if (body !== undefined) {
      if (body instanceof FormData) {
        init.body = body; // browser sets the multipart boundary
      } else {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (networkErr) {
      throw new Error(`Network error: ${networkErr.message}. Is the backend running?`);
    }
    const isJson = (res.headers.get("content-type") || "").includes("application/json");
    const data = isJson ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status}).`);
    return data;
  }

  const id = (v) => encodeURIComponent(v);

  DD.api = {
    auth: {
      signup: (email, password, name) => req("POST", "/api/auth/signup", { email, password, name }),
      login: (email, password) => req("POST", "/api/auth/login", { email, password }),
      google: (credential) => req("POST", "/api/auth/google", { credential }),
      logout: () => req("POST", "/api/auth/logout"),
      me: () => req("GET", "/api/auth/me")
    },
    projects: {
      list: () => req("GET", "/api/projects"),
      get: (pid) => req("GET", `/api/projects/${id(pid)}`),
      create: (project) => req("POST", "/api/projects", project),
      save: (pid, project) => req("PUT", `/api/projects/${id(pid)}`, project),
      del: (pid) => req("DELETE", `/api/projects/${id(pid)}`)
    },
    documents: {
      upload: (pid, formData) => req("POST", `/api/projects/${id(pid)}/documents`, formData),
      list: (pid) => req("GET", `/api/projects/${id(pid)}/documents`),
      contentUrl: (docId) => `/api/documents/${id(docId)}/content`,
      del: (docId) => req("DELETE", `/api/documents/${id(docId)}`)
    },
    outcomes: {
      record: (payload) => req("POST", "/api/outcomes", payload),
      mine: () => req("GET", "/api/outcomes/mine"),
      similar: (descriptor) => req("POST", "/api/outcomes/similar", descriptor),
      stats: () => req("GET", "/api/outcomes/stats"),
      del: (outcomeId) => req("DELETE", `/api/outcomes/${id(outcomeId)}`)
    },
    llm: {
      run: (payload) => req("POST", "/api/llm", payload),
      status: () => req("GET", "/api/llm/status")
    }
  };
})();
