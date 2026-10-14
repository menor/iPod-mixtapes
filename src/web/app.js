// @ts-check
/**
 * The sync UI. It keeps no job state of its own: every screen is drawn from the
 * latest JobSnapshot the server streams (ADR 0003). Reload the tab and the server
 * sends the current snapshot again.
 */
import { h, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { describeDoingNow, describeOutcome, isWritingToIpod, mb, plural } from "./outcome.js";

/** @typedef {import("../shared/job.ts").JobSnapshot} JobSnapshot */
/** @typedef {import("../shared/job.ts").PlanPreview} PlanPreview */

function App() {
  const [jobId, setJobId] = useState(/** @type {string | null} */ (null));
  const [job, setJob] = useState(/** @type {JobSnapshot | null} */ (null));
  const [defaultMount, setDefaultMount] = useState("");
  const [loaded, setLoaded] = useState(false);

  // On open: find the newest job, so a reopened tab lands on the running sync.
  useEffect(() => {
    Promise.all([getJson("/settings"), fetch("/jobs/latest")]).then(async ([settings, latest]) => {
      setDefaultMount(settings.defaultMount);
      if (latest.ok) setJobId((await latest.json()).id);
      setLoaded(true);
    });
  }, []);

  // Follow the job. The first message is its current state; each later one replaces it.
  useEffect(() => {
    if (!jobId) return;
    const events = new EventSource(`/jobs/${jobId}/events`);
    events.onmessage = (e) => setJob(JSON.parse(e.data));
    return () => events.close();
  }, [jobId]);

  const startOver = () => {
    setJobId(null);
    setJob(null);
  };

  if (!loaded) return h("p", null, "Loading…");
  if (!jobId) return h(NewSyncForm, { defaultMount, onCreated: setJobId });
  if (!job) return h("p", null, "Connecting…");
  return h(JobScreen, { job, onStartOver: startOver });
}

/** @param {{ defaultMount: string, onCreated: (id: string) => void }} props */
function NewSyncForm({ defaultMount, onCreated }) {
  const [error, setError] = useState("");

  /** @param {SubmitEvent} e */
  const submit = async (e) => {
    e.preventDefault();
    const form = new FormData(/** @type {HTMLFormElement} */ (e.currentTarget));
    const res = await fetch("/jobs", {
      method: "POST",
      body: JSON.stringify({ playlist: form.get("playlist"), mount: form.get("mount") }),
    });
    const body = await res.json();
    if (res.ok) onCreated(body.id);
    else setError(body.error);
  };

  return h(
    "form",
    { onSubmit: submit },
    h("h1", null, "Sync a playlist"),
    h("label", null, "Plex playlist", h("input", { name: "playlist", required: true })),
    h("label", null, "iPod folder", h("input", { name: "mount", required: true, value: defaultMount })),
    h("button", { type: "submit" }, "Show plan"),
    error && h("p", { class: "error" }, error),
  );
}

/** @param {{ job: JobSnapshot, onStartOver: () => void }} props */
function JobScreen({ job, onStartOver }) {
  switch (job.phase) {
    case "planning":
      return h("p", null, `Reading playlist "${job.playlistName}" and the iPod…`);
    case "awaiting-approval":
      return h(Preview, { job });
    case "done":
    case "failed":
      return h(EndScreen, { job, onStartOver });
    default:
      return h(LiveScreen, { job });
  }
}

/** @param {{ job: JobSnapshot }} props */
function LiveScreen({ job }) {
  return h(
    "div",
    null,
    isWritingToIpod(job.phase) && h("p", { class: "warning" }, "Do not unplug the iPod."),
    h("p", { class: "doing-now" }, describeDoingNow(job)),
    h(Summary, { job }),
  );
}

/** @param {{ job: JobSnapshot, onStartOver: () => void }} props */
function EndScreen({ job, onStartOver }) {
  const o = describeOutcome(job);
  return h(
    "div",
    null,
    h("h1", { class: `tone-${o.tone}` }, o.headline),
    h(
      "dl",
      null,
      job.error && [h("dt", null, "Why"), h("dd", null, job.error)],
      h("dt", null, "iPod now"),
      h("dd", null, o.ipodState),
      o.fix && [h("dt", null, "How to fix"), h("dd", null, o.fix)],
      h("dt", null, "Safe to unplug?"),
      h("dd", null, o.safeToUnplug),
    ),
    o.warnings.map((w) => h("p", { class: "note" }, w)),
    job.skipped.length > 0 &&
      h(
        "details",
        { open: job.skipped.length <= 5 },
        h("summary", null, `Missing tracks (${job.skipped.length})`),
        h("ul", null, job.skipped.map((s) => h("li", null, h("strong", null, s.title), ` — ${s.reason}`))),
      ),
    h(Summary, { job }),
    h("button", { onClick: onStartOver }, "Start another sync"),
  );
}

/** Numbers only, no log. @param {{ job: JobSnapshot }} props */
function Summary({ job }) {
  return h(
    "dl",
    { class: "summary" },
    h("dt", null, "Phase"),
    h("dd", null, job.phase),
    h("dt", null, "Tracks"),
    h("dd", null, `${job.tracksDone} of ${job.tracksTotal} copied`),
    h("dt", null, "Copied"),
    h("dd", null, mb(job.bytesDone)),
    h("dt", null, "Failures"),
    h("dd", null, String(job.skipped.length)),
    h("dt", null, "Retries"),
    h("dd", null, String(job.retried.reduce((sum, r) => sum + r.retries, 0))),
  );
}

/** @param {{ job: JobSnapshot }} props */
function Preview({ job }) {
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const plan = /** @type {PlanPreview} */ (job.plan);

  const approve = async () => {
    setSending(true);
    const res = await fetch(`/jobs/${job.id}/approve`, { method: "POST" });
    if (!res.ok) {
      setError((await res.json()).error);
      setSending(false);
    }
    // On success the next snapshot moves the screen on.
  };

  return h(
    "div",
    null,
    h("h1", null, job.playlistName),
    h(
      "dl",
      null,
      h("dt", null, "Will copy"),
      h("dd", null, `${plural(job.tracksTotal, "track")}, ${formatSize(plan)}`),
      h("dt", null, "Will erase"),
      h(
        "dd",
        null,
        plan.ipodTracksNow === 0
          ? "Nothing. The iPod has no tracks now."
          : `${plural(plan.ipodTracksNow, "track")} now on the iPod`,
      ),
      h("dt", null, "iPod folder"),
      h("dd", null, job.mountPath),
    ),
    h(
      "p",
      { class: "warning" },
      "This erases all music on the iPod. The backup saves the track list only, not the songs.",
    ),
    h(
      "button",
      { onClick: approve, disabled: sending },
      `Erase iPod and sync ${plural(job.tracksTotal, "track")}`,
    ),
    error && h("p", { class: "error" }, error),
  );
}

/** @param {PlanPreview} plan */
function formatSize(plan) {
  const size = `${Math.round(plan.totalBytes / 1_000_000)} MB`;
  if (plan.unknownSizes === 0) return size;
  return `at least ${size} (${plural(plan.unknownSizes, "track")} without a size)`;
}

/** @param {string} url */
async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

render(h(App, null), /** @type {HTMLElement} */ (document.getElementById("app")));
