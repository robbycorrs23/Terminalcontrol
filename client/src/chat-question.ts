/**
 * The AskUserQuestion card (see claude-driver.js) — moved out of agent-chat.ts
 * unchanged. agent-chat.ts appends it to the log, keeps it by requestId, and
 * sends the answers the card hands to `onAnswer`.
 */
import type { AgentEvent } from "./agent-events";
import { el } from "./chat-steps";

type QuestionEvent = Extract<AgentEvent, { t: "question" }>;

/**
 * The interactive AskUserQuestion prompt (see claude-driver.js). Each
 * question renders its options as buttons plus an "Other…" write-in — the
 * tool provides an Other affordance automatically in its native UI, and its
 * answer is just a free string, so a typed value slots into the same answers
 * map as a chosen label. Single-select submits on click; multi-select and
 * write-ins wait for Submit. Answers are keyed by question TEXT (the shape
 * the tool echoes back) and sent as one `answer` message once complete.
 */
export function createQuestionCard(ev: QuestionEvent, onAnswer: (answers: Record<string, string>) => void): HTMLElement {
  const card = el("div", "question-card");
  const picks = new Map<string, Set<string>>(); // question text -> chosen option labels
  const custom = new Map<string, string>(); // question text -> "Other" free text (when active)

  // The final answer for a question: chosen labels plus any active write-in,
  // comma-joined (the tool's own multi-select encoding).
  const answerFor = (q: string) => {
    const parts = [...(picks.get(q) || [])];
    const c = (custom.get(q) || "").trim();
    if (c) parts.push(c);
    return parts.join(", ");
  };
  const answered = (q: string) => (picks.get(q)?.size ?? 0) > 0 || (custom.get(q) || "").trim().length > 0;

  // Submit is created on demand: a single-select single-question card answers
  // on click and needs none — until the user picks "Other" and needs a way
  // to send the typed text.
  let submitBtn: HTMLButtonElement | null = null;
  const ensureSubmit = () => {
    if (submitBtn) return;
    submitBtn = document.createElement("button");
    submitBtn.className = "ctl q-submit";
    submitBtn.textContent = "Submit";
    submitBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      trySubmit();
    });
    card.append(submitBtn);
  };

  const trySubmit = () => {
    if (!ev.questions.every((q) => answered(q.question))) return;
    const answers: Record<string, string> = {};
    for (const q of ev.questions) answers[q.question] = answerFor(q.question);
    card.classList.add("resolved");
    card.querySelectorAll("button, input").forEach((b) => ((b as HTMLInputElement).disabled = true));
    renderQuestionSummary(card, answers);
    onAnswer(answers);
  };

  for (const q of ev.questions) {
    picks.set(q.question, new Set<string>());
    const block = el("div", "q-block");
    if (q.header) {
      const h = el("div", "q-header");
      h.textContent = q.header;
      block.append(h);
    }
    const qt = el("div", "q-text");
    qt.textContent = q.question;
    block.append(qt);

    const opts = el("div", "q-opts");

    // "Other…" write-in row, revealed when its option is chosen.
    const otherWrap = el("div", "q-other");
    otherWrap.hidden = true;
    const otherInput = document.createElement("input");
    otherInput.type = "text";
    otherInput.className = "q-other-input";
    otherInput.placeholder = "Type your own answer…";
    otherInput.addEventListener("input", () => custom.set(q.question, otherInput.value));
    otherInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        trySubmit();
      }
    });
    otherWrap.append(otherInput);

    const deselectOpts = () => opts.querySelectorAll("button").forEach((x) => x.classList.remove("selected"));

    const otherBtn = document.createElement("button");
    otherBtn.className = "ctl q-opt q-opt-other";
    const olbl = el("span", "q-opt-label");
    olbl.textContent = "✎ Other…";
    otherBtn.append(olbl);

    for (const o of q.options) {
      const b = document.createElement("button");
      b.className = "ctl q-opt";
      const lbl = el("span", "q-opt-label");
      lbl.textContent = o.label;
      b.append(lbl);
      if (o.description) {
        const d = el("span", "q-opt-desc");
        d.textContent = o.description;
        b.append(d);
      }
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const set = picks.get(q.question)!;
        if (q.multiSelect) {
          if (set.has(o.label)) set.delete(o.label);
          else set.add(o.label);
          b.classList.toggle("selected", set.has(o.label));
        } else {
          set.clear();
          set.add(o.label);
          deselectOpts();
          b.classList.add("selected");
          // A concrete pick cancels an in-progress write-in.
          otherBtn.classList.remove("selected");
          otherWrap.hidden = true;
          custom.delete(q.question);
          trySubmit();
        }
      });
      opts.append(b);
    }

    otherBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (q.multiSelect) {
        const active = otherBtn.classList.toggle("selected");
        otherWrap.hidden = !active;
        if (active) otherInput.focus();
        else {
          custom.delete(q.question);
          otherInput.value = "";
        }
      } else {
        // Single-select: "Other" becomes the sole selection.
        picks.get(q.question)!.clear();
        deselectOpts();
        otherBtn.classList.add("selected");
        otherWrap.hidden = false;
        otherInput.focus();
        ensureSubmit(); // this card had none; the write-in needs one
      }
    });
    opts.append(otherBtn);

    block.append(opts, otherWrap);
    card.append(block);
  }

  // Multi-select or multi-question cards always need an explicit Submit;
  // single-select single-question cards get one lazily via "Other".
  if (ev.questions.some((q) => q.multiSelect) || ev.questions.length > 1) ensureSubmit();

  return card;
}

export function resolveQuestionCard(card: HTMLElement, answers: Record<string, string>) {
if (card.classList.contains("resolved")) return;
  card.classList.add("resolved");
  card.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
  // Reflect the choice made on another window (or before a reconnect).
  for (const [q, ans] of Object.entries(answers)) {
    card.querySelectorAll(".q-block").forEach((block) => {
      if (block.querySelector(".q-text")?.textContent !== q) return;
      block.querySelectorAll(".q-opt").forEach((b) => {
        const label = b.querySelector(".q-opt-label")?.textContent || "";
        if (ans.split(", ").includes(label)) b.classList.add("selected");
      });
    });
  }
  renderQuestionSummary(card, answers);
}

function renderQuestionSummary(card: HTMLElement, answers: Record<string, string>) {
  let foot = card.querySelector(".q-foot") as HTMLElement | null;
  if (!foot) {
    foot = el("div", "q-foot");
    card.append(foot);
  }
  foot.textContent = "✓ " + Object.values(answers).join(" · ");
}
