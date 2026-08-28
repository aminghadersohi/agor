/**
 * Iframe-side runtime injected into every artifact's bundle at render time.
 *
 * Listens for `postMessage` queries from the Agor parent page and replies
 * with serialized data from the iframe's DOM. Standard browser APIs only —
 * no Sandpack-internal coupling. The parent uses
 * `useSandpackClient().iframe.current.contentWindow.postMessage(...)` to
 * dispatch; the daemon WebSocket-fans-out the request and correlates the
 * reply.
 *
 * Injection: served as a `data:text/javascript;base64,…` URL in
 * `sandpack_config.options.externalResources`. Sandpack adds the resulting
 * `<script src="…">` tag to the iframe HTML before any user code runs, so
 * the listener is registered before the bundle boots and we don't have to
 * mutate any user files (no entry-file detection, no `import` prepended,
 * no template-specific resolver issues).
 *
 * Wire format:
 *   parent → iframe: { type: 'agor:query', requestId, kind, args }
 *   iframe → parent: { type: 'agor:result', requestId, ok: bool, result?, error? }
 *
 * Supported `kind`:
 *   - `query_dom` — args: { selector, multiple?, maxNodes? }
 *   - `document_html` — args: {}
 *
 * Also exposes the declared-binding API on `window.agor`. Each call names an
 * artifact-local binding id and nothing else — no tool name, route, argument,
 * or credential — and the parent resolves it server-side against the
 * artifact's persisted metadata:
 *   - `runAction(actionId)`  → write, via POST /artifacts/:id/actions/:actionId
 *   - `fetchData(dataId)`    → read,  via GET  /artifacts/:id/data/:dataId
 *   - `openChat(chatId?)`    → opens a declared session in the parent surface
 * See `context/explorations/artifact-interaction-bindings.md`.
 *
 * Caps everything (per-element HTML, total HTML, node count) so an
 * artifact with a giant DOM can't blow up the wire / agent context.
 *
 * NOT persisted — generated and injected per-render in `getPayload()`,
 * never enters the file map or the persisted `sandpack_config`.
 */
export const AGOR_RUNTIME_SOURCE = `// agor-runtime.js — injected by Agor at render time. Do not edit.
// Source: apps/agor-daemon/src/utils/agor-runtime-source.ts
(function () {
  if (typeof window === 'undefined') return;
  if (window.__agor_runtime_installed__) return;
  window.__agor_runtime_installed__ = true;

  var MAX_NODES = 50;
  var MAX_HTML_PER_NODE = 50000;
  var MAX_TEXT_PER_NODE = 5000;
  var MAX_DOC_HTML = 200000;
  var interactionSequence = 0;
  var interactionPending = {};

  function requestParentInteraction(type, payload) {
    return new Promise(function (resolve, reject) {
      if (!window.parent || window.parent === window) {
        reject(new Error('Agor parent is unavailable'));
        return;
      }
      interactionSequence += 1;
      var requestId = 'artifact-interaction-' + Date.now() + '-' + interactionSequence;
      var timeout = setTimeout(function () {
        delete interactionPending[requestId];
        reject(new Error('Agor interaction timed out'));
      }, 30000);
      interactionPending[requestId] = { resolve: resolve, reject: reject, timeout: timeout };
      var message = { type: type, requestId: requestId };
      for (var key in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) message[key] = payload[key];
      }
      window.parent.postMessage(message, '*');
    });
  }

  var existingAgor = window.agor && typeof window.agor === 'object' ? window.agor : {};
  existingAgor.runAction = function (actionId) {
    if (typeof actionId !== 'string' || !actionId) {
      return Promise.reject(new Error('actionId required'));
    }
    return requestParentInteraction('agor:run-action', { actionId: actionId });
  };
  existingAgor.fetchData = function (dataId) {
    if (typeof dataId !== 'string' || !dataId) {
      return Promise.reject(new Error('dataId required'));
    }
    return requestParentInteraction('agor:fetch-data', { dataId: dataId });
  };
  existingAgor.openChat = function (chatId) {
    return requestParentInteraction('agor:open-chat', {
      chatId: typeof chatId === 'string' && chatId ? chatId : undefined,
    });
  };
  window.agor = existingAgor;

  function serializeEl(el) {
    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      attrs[a.name] = a.value;
    }
    var html = el.outerHTML || '';
    if (html.length > MAX_HTML_PER_NODE) {
      html = html.slice(0, MAX_HTML_PER_NODE) + '... [truncated]';
    }
    var text = (el.textContent || '');
    if (text.length > MAX_TEXT_PER_NODE) {
      text = text.slice(0, MAX_TEXT_PER_NODE) + '... [truncated]';
    }
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      attributes: attrs,
      textContent: text,
      outerHTML: html,
    };
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (
      event.source === window.parent &&
      data &&
      typeof data === 'object' &&
      data.type === 'agor:interaction-result'
    ) {
      var pending = interactionPending[data.requestId];
      if (!pending) return;
      clearTimeout(pending.timeout);
      delete interactionPending[data.requestId];
      if (data.ok) pending.resolve(data.result);
      else pending.reject(new Error(data.error || 'Agor interaction failed'));
      return;
    }
    if (!data || typeof data !== 'object' || data.type !== 'agor:query') return;
    var requestId = data.requestId;
    var kind = data.kind;
    var args = data.args || {};

    function reply(payload) {
      try {
        var msg = { type: 'agor:result', requestId: requestId };
        for (var k in payload) {
          if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k];
        }
        msg.ok = !payload.error;
        // event.source is the parent window. '*' targetOrigin because the
        // iframe runs cross-origin from a Sandpack bundler URL we don't
        // control. Replies carry no secrets — only whatever the iframe's
        // DOM already contains, which the parent rendered itself.
        if (event.source && typeof event.source.postMessage === 'function') {
          event.source.postMessage(msg, '*');
        }
      } catch (e) {
        // Source closed or throwed; nothing to do.
      }
    }

    try {
      if (kind === 'query_dom') {
        var selector = args.selector;
        if (typeof selector !== 'string' || selector.length === 0) {
          return reply({ error: 'selector required (CSS selector string)' });
        }
        var multiple = args.multiple === true;
        var requestedMax = typeof args.maxNodes === 'number' ? args.maxNodes : MAX_NODES;
        var maxNodes = Math.max(1, Math.min(requestedMax, MAX_NODES));

        var nodes;
        if (multiple) {
          nodes = Array.prototype.slice.call(document.querySelectorAll(selector), 0, maxNodes);
        } else {
          var single = document.querySelector(selector);
          nodes = single ? [single] : [];
        }
        var serialized = [];
        for (var i = 0; i < nodes.length; i++) serialized.push(serializeEl(nodes[i]));
        return reply({ result: { matched: serialized.length, nodes: serialized } });
      }

      if (kind === 'document_html') {
        var html = (document.documentElement && document.documentElement.outerHTML) || '';
        if (html.length > MAX_DOC_HTML) {
          html = html.slice(0, MAX_DOC_HTML) + '... [truncated]';
        }
        return reply({ result: { html: html, length: html.length } });
      }

      return reply({ error: 'unknown query kind: ' + String(kind) });
    } catch (err) {
      return reply({ error: (err && err.message) ? err.message : String(err) });
    }
  });

  // Announce readiness to the parent so it knows the iframe is wired up
  // before sending any queries (avoids a race on first-paint).
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'agor:ready' }, '*');
    }
  } catch (e) {
    /* parent closed */
  }
})();
`;
