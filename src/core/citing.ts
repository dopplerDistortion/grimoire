// What cites a trace (spec §3 Delete and purge, §20 Attempt page): the wiki
// pages that name it among their sources, and the live skill proposals that
// cite it, by the trace itself or by one of its items (`trace:`, `issue:`,
// `debrief:`, `excerpt:<handle>/…`). purge_trace's `cited_by` and the attempt
// page (whose list feeds the purge confirmation) both read it here, so they
// never disagree.
import type { ProposalRecord, TrackerView, WikiPage } from '../tracker';

/** The wiki pages that cite the trace `handle`, by slug. */
export async function citingPages(view: TrackerView, handle: string): Promise<WikiPage[]> {
  return (await view.wiki.pages()).filter((page) => page.sources.includes(handle)).sort((x, y) => (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
}

/** The live proposals that cite the trace `handle`. */
export async function citingProposals(view: TrackerView, handle: string): Promise<ProposalRecord[]> {
  const citing = (proposal: ProposalRecord) =>
    proposal.traces.some((trace) => trace.trace === handle) ||
    proposal.citations.some((item) => item === `trace:${handle}` || item === `issue:${handle}` || item === `debrief:${handle}` || item.startsWith(`excerpt:${handle}/`));
  return (await view.proposals.records()).filter(citing);
}
