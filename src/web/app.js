// @ts-check
/**
 * The sync UI. It keeps no job state of its own: every screen is drawn from the
 * latest JobSnapshot the server streams (ADR 0003). Reload the tab and the server
 * sends the current snapshot again.
 */
import { h, render } from "preact";
import { useEffect, useState } from "preact/hooks";

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
      return h(
        "div",
        null,
        h("h1", null, "Done"),
        h("p", null, `${plural(job.tracksDone, "track")} of ${job.tracksTotal} on the iPod.`),
        job.skipped.length > 0 && h("p", { class: "error" }, `${plural(job.skipped.length, "track")} skipped.`),
        h("button", { onClick: onStartOver }, "Start another sync"),
      );
    case "failed":
      return h(
        "div",
        null,
        h("h1", null, "Failed"),
        h("p", { class: "error" }, job.error),
        h("button", { onClick: onStartOver }, "Start another sync"),
      );
    default:
      // Session 5 replaces this with the "doing now" line and the summary block.
      return h("p", null, `${job.phase}: ${job.tracksDone} of ${job.tracksTotal} tracks done`);
  }
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
  const mb = `${Math.round(plan.totalBytes / 1_000_000)} MB`;
  if (plan.unknownSizes === 0) return mb;
  return `at least ${mb} (${plural(plan.unknownSizes, "track")} without a size)`;
}

/** @param {number} n @param {string} word */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** @param {string} url */
async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

render(h(App, null), /** @type {HTMLElement} */ (document.getElementById("app")));
