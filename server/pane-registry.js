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
export function createRegistry(ptys, agents) {
  const ownerOf = (id) => (ptys.info(id) ? ptys : agents.info(id) ? agents : null);

  return {
    list: (session) => [...ptys.list(session), ...agents.list(session)],
    dormantList: (session) => ptys.dormantList(session),
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
    reorder: (session, ids) => {
      ptys.reorder(session, ids);
      agents.reorder(session, ids);
    },
    setAttention: (id, kind) => ownerOf(id)?.setAttention(id, kind),
    clearAttention: (id) => ownerOf(id)?.clearAttention(id),
    setFollowUp: (id, on) => ownerOf(id)?.setFollowUp(id, on),
    setColor: (id, color) => ownerOf(id)?.setColor(id, color),
    setName: (id, name) => ownerOf(id)?.setName(id, name),
    setLastInput: (id, text) => ownerOf(id)?.setLastInput(id, text),
    lastInputOf: (id) => ownerOf(id)?.lastInputOf(id) ?? "",
  };
}
