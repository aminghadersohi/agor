# Worked example: a release console artifact

A single-file `static` artifact that shows a schedule's live state, offers three
configured buttons, and opens a chat surface. Everything it can do is declared
in metadata; the file below contains no credentials, no URLs, and no schedule or
session identifiers.

All names and values here are fictional.

## Publish it

```ts
agor_artifacts_publish({
  branchId,
  boardId,
  subpath: '.agor/artifacts/release-console',
  name: 'Release console',
  template: 'static',
  interactionConfig: {
    data: [
      {
        id: 'nightly',
        label: 'Nightly release check',
        kind: 'schedule_status',
        scheduleId: nightlyScheduleId,
      },
    ],
    actions: [
      {
        id: 'run-now',
        label: 'Run once',
        scheduleId: nightlyScheduleId,
        confirm: true,
        description: 'Starts one release-check session now.',
      },
      { id: 'arm', label: 'Arm', scheduleId: nightlyScheduleId, effect: 'enable' },
      {
        id: 'disarm',
        label: 'Disarm',
        scheduleId: nightlyScheduleId,
        effect: 'disable',
        confirm: true,
      },
    ],
    chats: [{ id: 'triage', label: 'Release triage', sessionId: triageSessionId }],
  },
});
```

To retire the triage conversation later and point the same widget at a fresh
one, patch the metadata — the artifact's code does not change:

```ts
agor_artifacts_update({
  artifactId,
  interactionConfig: {
    /* ...same data/actions... */
    chats: [{ id: 'triage', label: 'Release triage', sessionId: newTriageSessionId }],
  },
});
```

## `/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      body {
        margin: 0;
        padding: 1.25rem;
        font-family: system-ui, sans-serif;
        background: #101315;
        color: #eef5f5;
      }
      h1 {
        font-size: 1.1rem;
        margin: 0 0 0.75rem;
      }
      .state {
        display: flex;
        gap: 0.5rem;
        align-items: baseline;
        margin-bottom: 0.25rem;
      }
      .pill {
        border-radius: 999px;
        padding: 0.15rem 0.6rem;
        font-size: 0.75rem;
        font-weight: 650;
      }
      .on {
        background: #10402f;
        color: #7ee2db;
      }
      .off {
        background: #3a2320;
        color: #f0a89c;
      }
      .meta {
        color: #9caeae;
        font-size: 0.85rem;
        line-height: 1.5;
      }
      .row {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
        margin-top: 1rem;
      }
      button {
        border: 0;
        border-radius: 999px;
        padding: 0.5rem 0.9rem;
        background: #167f79;
        color: #fff;
        font-weight: 650;
        cursor: pointer;
      }
      button.secondary {
        background: #23313a;
      }
      button:disabled {
        opacity: 0.55;
        cursor: default;
      }
      button:focus-visible {
        outline: 3px solid #7ee2db;
        outline-offset: 3px;
      }
      #status {
        margin-top: 0.75rem;
        min-height: 1.2em;
      }
    </style>
  </head>
  <body>
    <h1>Nightly release check</h1>
    <div class="state">
      <span id="armed" class="pill off">unknown</span>
      <span id="cron" class="meta"></span>
    </div>
    <div id="lastrun" class="meta"></div>

    <div class="row">
      <button id="run" type="button">Run once</button>
      <button id="arm" type="button" class="secondary">Arm</button>
      <button id="disarm" type="button" class="secondary">Disarm</button>
      <button id="chat" type="button" class="secondary">Release triage</button>
    </div>
    <div id="status" class="meta" role="status"></div>

    <script>
      var statusEl = document.getElementById('status');
      var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));

      function setBusy(busy) {
        buttons.forEach(function (b) {
          b.disabled = busy;
        });
      }

      function formatTime(ms) {
        return ms ? new Date(ms).toLocaleString() : 'never';
      }

      // Read: names a declared data binding. No schedule id, no route, no args.
      async function refresh() {
        try {
          var s = await window.agor.fetchData('nightly');
          var armed = document.getElementById('armed');
          armed.textContent = s.enabled ? 'armed' : 'disarmed';
          armed.className = 'pill ' + (s.enabled ? 'on' : 'off');
          document.getElementById('cron').textContent = s.cron_expression + ' (' + s.name + ')';
          document.getElementById('lastrun').textContent =
            'Last run ' + formatTime(s.last_run_at) + ' · next ' + formatTime(s.next_run_at);
        } catch (error) {
          // A viewer without access to the source branch lands here; render the
          // unavailable state rather than pretending the widget works.
          statusEl.textContent = error.message || 'Could not read schedule status';
        }
      }

      // Write: names a declared action binding. Which schedule, and whether
      // `enabled` becomes true or false, were pinned at publish time.
      function wire(id, actionId, done) {
        document.getElementById(id).addEventListener('click', async function () {
          setBusy(true);
          statusEl.textContent = 'Working…';
          try {
            await window.agor.runAction(actionId);
            statusEl.textContent = done;
            await refresh();
          } catch (error) {
            statusEl.textContent = error.message || 'Action failed';
          } finally {
            setBusy(false);
          }
        });
      }

      wire('run', 'run-now', 'Started a release-check session.');
      wire('arm', 'arm', 'Schedule armed.');
      wire('disarm', 'disarm', 'Schedule disarmed.');

      document.getElementById('chat').addEventListener('click', async function () {
        try {
          await window.agor.openChat('triage');
          statusEl.textContent = 'Opened release triage.';
        } catch (error) {
          statusEl.textContent = error.message || 'Could not open chat';
        }
      });

      refresh();
    </script>
  </body>
</html>
```

## What this demonstrates

- The file has no secrets and no identifiers. Move it to another Agor instance
  and it renders inert until someone declares bindings for it.
- `run-now`, `arm`, and `disarm` are three separate declared actions against one
  schedule. The artifact cannot invent a fourth, and cannot flip `arm` into
  `disarm` — `enabled` is pinned per binding.
- Every button fails cleanly for a viewer who is not the schedule's creator,
  because it lands on the same `run-now` / `PATCH` routes that already enforce
  that rule.
- `refresh()` runs on load. That is safe because it is a read; nothing here can
  auto-fire a write, and any action declared with `confirm: true` additionally
  requires a parent-page confirmation the iframe cannot forge.
