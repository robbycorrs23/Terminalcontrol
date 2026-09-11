/**
 * Thin façade over the two pane managers (`PtyManager` for terminal panes,
 * `AgentManager` for SDK-driven chat panes) so most of index.js's routes can
 * call one `registry.<method>` instead of branching on which manager owns a
 * pane id. Every method dispatches by ownership (or unions across both for
 * `list`/`idsOf`); a few are deliberately one-sided because only PTY panes
 * have the concept at all (dormant/respawn/discard — agent panes have no
 * dormant tier, see agent-manager.js's class doc comment).
 *
 * Deliberately excludes `attach` (the `/term` WS bridge — agent panes get
 * their own `/agent` WS instead) and the `tmux`/`on()` surface, which stay
 * direct on `ptys` in index.js.
 *
 * KNOWN LIMITATION: `reorder()` calls both managers' `reorder`, each of
 * which (matching PtyManager's existing behavior exactly) assigns `order`
 * sequentially only among the ids it owns, skipping ids it doesn't. Two
 * panes of different kinds can therefore tie on `order` after a
 * drag-reorder that mixes kinds in one window — `list()`'s union sort
 * doesn't fully resolve within a tie. Cosmetic only (grid position can be
 * slightly off until the next reorder), not a data-integrity issue; fixing
 * it for real means either a shared order counter or a registry-side
 * re-normalization pass, either of which is a bigger change than this
 * façade's job today.
 */
import { trustFolder } from "./claude-trust.js";
import { ALL_PROFILES } from "./machine-config.js";
/**
 * The agent profiles a pane can be flipped between views as. A pane's `cmd` is
 * the picker option it was opened with, except that a PTY pane flipped over
 * from chat carries resume arguments too ("claude-work --resume <id>") — hence
 * the first-token match rather than a plain lookup. Anything else (a plain
 * shell, an `ssh ...` string) has no chat equivalent and is left alone.
 */
function baseProfile(cmd) {
  const first = String(cmd || "").trim().split(/\s+/)[0];
  // Against the catalogue, not this machine's offered subset: a pane already
  // running an account is flippable even if that account was later removed from
  // the picker, which is the difference between "don't offer this" and "break
  // what is already open".
  return ALL_PROFILES.some((p) => p.id === first) ? first : "";
}

/**
 * Permission modes the `claude` CLI accepts for `--permission-mode`. The chat
 * view's selector and the CLI overlap but are NOT the same set: the chat
 * "default" (Ask) has no flag spelling — it IS the default — so it is carried
 * across the flip in `agentMode` but never put on the command line. Anything
 * unrecognised is dropped rather than passed through, because an invalid value
 * makes `claude` exit at startup and the box would just sit there empty.
 */
const CLI_PERMISSION_MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "plan"]);

/**
 * What a terminal pane should type to pick a conversation back up, at the mode
 * it was running at. Claude takes `--resume <session-id>` and
 * `--permission-mode <mode>`; codex is deliberately started FRESH, because its
 * resume story here is unverified and silently attaching to the wrong
 * conversation is worse than visibly starting a new one — `flip` reports
 * `resumed:false` so the UI can say so.
 */
function resumeCommand(profile, sid, mode) {
  if (profile.startsWith("codex")) return profile;
  let cmd = profile;
  if (sid) cmd += ` --resume ${sid}`;
  if (CLI_PERMISSION_MODES.has(mode)) cmd += ` --permission-mode ${mode}`;
  return cmd;
}

export function createRegistry(ptys, agents) {
  const ownerOf = (id) => (ptys.info(id) ? ptys : agents.info(id) ? agents : null);

  return {
    // ONE WORKSPACE PER MACHINE — the `session` argument is deliberately
    // ignored here.
    //
    // Panes used to be scoped to a session (= one browser window), so every
    // window got its own independent set of terminals and a second window
    // started empty. That model can't survive a phone: an installed PWA cold-
    // launches with no session and a manifest `start_url` that has nowhere to
    // put one, so it would always open an empty grid instead of the fleet you
    // actually run. Sharing via a hand-copied `?session=` URL is not a
    // substitute for the app icon just working.
    //
    // So the workspace boundary is now the SERVER, not the browser window:
    // every client of this FleetView sees the same panes, and separate
    // workspaces come from running FleetView on separate machines (which is
    // already how the tailnet is laid out). Panes still carry a `session`
    // field and `sessionOf()` still reports it — it's what secret release and
    // reorder key on — but nothing filters visibility by it any more.
    // Sorted ACROSS both managers, not just concatenated. Concatenating put
    // every terminal pane before every chat pane whatever their `order`, so
    // flipping one box's view teleported it to the top or the bottom of the
    // grid — the position is a property of the workspace, not of which manager
    // happens to own the pane.
    list: () =>
      [...ptys.list(), ...agents.list()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    dormantList: () => ptys.dormantList(),
    info: (id) => ownerOf(id)?.info(id) ?? null,
    sessionOf: (id) => ownerOf(id)?.sessionOf(id) ?? null,
    idsOf: (session) => [...ptys.idsOf(session), ...agents.idsOf(session)],
    create: (opts) => (opts.kind === "agent" ? agents.create(opts) : ptys.create(opts)),
    kill: (id) => ownerOf(id)?.kill(id),
    respawn: (id) => ptys.respawn(id),
    discardDormant: (id) => ptys.discardDormant(id),
    // Layout "Replace": PTY panes go non-destructively dormant ("died", kept
    // for the recovery bar); agent panes have no dormant tier, so this just
    // kills them — the caller distinguishes via `type` to broadcast the
    // right message so the client doesn't end up with a ghost box.
    setAside: (id) => {
      if (ptys.info(id)) return { type: "died", info: ptys.setAside(id) };
      if (agents.info(id)) {
        agents.setAside(id);
        return { type: "closed", id };
      }
      return null;
    },
    // ONE sequence shared by both managers. Handing the same id list to each
    // manager's own `reorder` gives two independent 0..n runs that collide
    // pane-for-pane; numbering here and pushing the result down is what keeps a
    // mixed grid in the order the user actually dragged it into.
    reorder: (session, ids) => {
      const orderById = new Map();
      let i = 0;
      for (const id of ids) if (ownerOf(id)) orderById.set(id, i++);
      ptys.applyOrder(orderById);
      agents.applyOrder(orderById);
    },
    setAttention: (id, kind) => ownerOf(id)?.setAttention(id, kind),
    // PTY-only: agent panes get their working state from the SDK driver's own
    // status events (agent-manager.js), not from shell hooks — hence the `?.`.
    setWorking: (id, on) => ownerOf(id)?.setWorking?.(id, on),
    clearAttention: (id) => ownerOf(id)?.clearAttention(id),
    setFollowUp: (id, on) => ownerOf(id)?.setFollowUp(id, on),
    setColor: (id, color) => ownerOf(id)?.setColor(id, color),
    setName: (id, name) => ownerOf(id)?.setName(id, name),
    setLastInput: (id, text) => ownerOf(id)?.setLastInput(id, text),
    lastInputOf: (id) => ownerOf(id)?.lastInputOf(id) ?? "",

    /**
     * Move one pane to the other view. There is no such thing as re-rendering a
     * pane in the other view: a chat pane is an in-process SDK driver with no
     * terminal behind it, and a terminal pane is a tmux shell with no event
     * stream. So a flip is destroy-and-recreate, and the ONLY thing that makes
     * it feel like a view switch rather than a restart is that both halves
     * resume the same Claude conversation by session id.
     *
     * Refuses rather than guesses in three cases: the pane is mid-turn (a flip
     * kills the running process, so an in-flight turn would be cut off), the
     * pane isn't an agent at all (plain shell / raw ssh), or it's a terminal
     * pane whose agent hasn't reported a session id yet (flipping it to chat
     * would silently open an empty conversation).
     *
     * Returns { ok, reason?, id?, info?, resumed? } — `id` is the OLD pane id,
     * which the caller must broadcast as closed, and `info` the new pane.
     */
    flip: (id) => {
      const owner = ownerOf(id);
      if (!owner) return { ok: false, reason: "gone" };
      const info = owner.info(id);
      if (info.working) return { ok: false, reason: "busy" };

      const profile = baseProfile(info.cmd);
      if (!profile) return { ok: false, reason: "not an agent pane" };
      // A chat pane running over ssh has no local tmux equivalent — its agent
      // lives on another host, reached by the driver, not by a shell here.
      if (info.kind === "agent" && info.remote) return { ok: false, reason: "remote pane" };

      const carry = { cwd: info.cwd, session: info.session };
      const toChat = info.kind === "pty";
      const sid = toChat ? ptys.sdkSessionIdOf(id) : agents.sdkSessionIdOf(id);
      if (toChat && !sid) return { ok: false, reason: "no conversation captured yet" };

      // The permission mode has to survive the round trip in BOTH directions or
      // a chat → terminal → chat flip quietly resets an Auto pane to Ask. Chat
      // panes own the mode; terminal panes just hold onto it (and start
      // `claude` at it) until the pane comes back.
      const mode = toChat ? ptys.agentModeOf(id) : info.mode || "default";

      // Chat panes never trigger Claude Code's workspace-trust dialog (the SDK
      // doesn't ask), so a folder used only through chat is unknown to the
      // interactive CLI and the flipped-to terminal would stop on "do you trust
      // this folder?" — which looks like the switch malfunctioning. Record the
      // trust the running pane already implied. Best-effort: if it doesn't
      // take, the user just sees the dialog they'd have seen anyway.
      if (!toChat) trustFolder(profile, info.cwd);

      // Past this point the old pane is gone, so nothing below may throw a
      // recoverable error — all the refusals are above.
      owner.kill(id);
      const pane = toChat
        ? agents.create({ ...carry, cmd: profile, sdkSessionId: sid, mode })
        : ptys.create({
            ...carry,
            cmd: resumeCommand(profile, sid, mode),
            sdkSessionId: sid,
            agentMode: mode,
          });

      // Carry the human-facing bits across so the box looks like the same box.
      if (info.name) ownerOf(pane.id)?.setName(pane.id, info.name);
      if (info.color) ownerOf(pane.id)?.setColor(pane.id, info.color);
      if (info.followUp) ownerOf(pane.id)?.setFollowUp(pane.id, true);

      return {
        ok: true,
        id,
        info: ownerOf(pane.id)?.info(pane.id) ?? null,
        resumed: toChat ? true : !!sid && !profile.startsWith("codex"),
      };
    },
  };
}
