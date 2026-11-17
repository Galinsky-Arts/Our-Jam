import type { Sql } from "./db.js";
import { requireThat } from "../../../packages/domain/src/index.js";

// OJ-030 recognition. Awards are recomputed on read from the frozen round
// snapshot stored with the generation job plus the round's open/close times.
// They never feed back into ranking, vote limits or generation input.
export const AWARD_RULES_VERSION = "awards-v1";
export const AWARD_RULES = {
  version: AWARD_RULES_VERSION,
  minimumSupporters: 3,
  earlySparkWindow: 0.25,
  lateBreakoutWindow: 1 / 3,
  lateBreakoutMaxRank: 3,
  minimumOtherSupport: 1,
} as const;

export type SnapshotWave = {
  id: string;
  text: string;
  votes: number;
  supporters: number;
  authorId: string;
  createdAt: string;
  otherPoints?: number;
};
export type Award = {
  kind: "crowd_pick" | "early_spark" | "late_breakout" | "most_supported";
  waveId: string;
  text: string;
  authorId: string;
  evidence: Record<string, number | string>;
};
export type RoundStats = {
  waves: number;
  includedWaves: number;
  totalSupport: number;
  averageVotesPerWave: number;
  medianVotesPerWave: number;
  sampleSufficient: boolean;
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** Pure, deterministic award computation (ledger replay). */
export function computeAwards(
  snapshot: { waves?: SnapshotWave[]; selected?: SnapshotWave[] },
  openedAt: Date,
  closedAt: Date,
): { stats: RoundStats; awards: Award[] } {
  const waves = Array.isArray(snapshot.waves) ? snapshot.waves : [];
  const selected = Array.isArray(snapshot.selected) ? snapshot.selected : [];
  const votes = waves.map((w) => Number(w.votes) || 0).sort((a, b) => a - b);
  const totalSupport = waves.reduce((n, w) => n + (Number(w.supporters) || 0), 0);
  const mid = Math.floor(votes.length / 2);
  const stats: RoundStats = {
    waves: waves.length,
    includedWaves: selected.length,
    totalSupport,
    averageVotesPerWave: votes.length
      ? round2(votes.reduce((a, b) => a + b, 0) / votes.length)
      : 0,
    medianVotesPerWave: votes.length
      ? votes.length % 2
        ? votes[mid]
        : round2((votes[mid - 1] + votes[mid]) / 2)
      : 0,
    sampleSufficient: totalSupport >= AWARD_RULES.minimumSupporters,
  };
  const awards: Award[] = [];
  if (!selected.length) return { stats, awards };
  const top = selected[0];
  awards.push({
    kind: "crowd_pick",
    waveId: top.id,
    text: top.text,
    authorId: top.authorId,
    evidence: { rank: 1, votes: top.votes, supporters: top.supporters },
  });
  if (!stats.sampleSufficient) return { stats, awards };
  const start = openedAt.getTime();
  const span = Math.max(1, closedAt.getTime() - start);
  const position = (w: SnapshotWave) =>
    Math.min(1, Math.max(0, (new Date(w.createdAt).getTime() - start) / span));
  const others = (w: SnapshotWave) =>
    Math.max(0, (Number(w.supporters) || 0) - 1);
  const early = selected
    .map((w, i) => ({ w, rank: i + 1 }))
    .filter(
      ({ w }) =>
        position(w) <= AWARD_RULES.earlySparkWindow &&
        others(w) >= AWARD_RULES.minimumOtherSupport,
    )[0];
  if (early)
    awards.push({
      kind: "early_spark",
      waveId: early.w.id,
      text: early.w.text,
      authorId: early.w.authorId,
      evidence: {
        rank: early.rank,
        submittedAtFraction: round2(position(early.w)),
        supporters: early.w.supporters,
      },
    });
  const late = selected
    .slice(0, AWARD_RULES.lateBreakoutMaxRank)
    .map((w, i) => ({ w, rank: i + 1 }))
    .filter(
      ({ w }) =>
        position(w) >= 1 - AWARD_RULES.lateBreakoutWindow &&
        others(w) >= AWARD_RULES.minimumOtherSupport,
    )[0];
  if (late)
    awards.push({
      kind: "late_breakout",
      waveId: late.w.id,
      text: late.w.text,
      authorId: late.w.authorId,
      evidence: {
        rank: late.rank,
        submittedAtFraction: round2(position(late.w)),
        supporters: late.w.supporters,
      },
    });
  const most = [...selected].sort(
    (a, b) => b.supporters - a.supporters || selected.indexOf(a) - selected.indexOf(b),
  )[0];
  if (most && most.id !== top.id)
    awards.push({
      kind: "most_supported",
      waveId: most.id,
      text: most.text,
      authorId: most.authorId,
      evidence: { supporters: most.supporters, votes: most.votes },
    });
  return { stats, awards };
}

export const AWARD_LABELS: Record<Award["kind"], string> = {
  crowd_pick: "Crowd pick",
  early_spark: "Early spark",
  late_breakout: "Late breakout",
  most_supported: "Most supported",
};

async function displayNames(db: Sql, ids: string[]) {
  if (!ids.length) return new Map<string, { name: string; avatarSeed: string }>();
  const rows = (
    await db.query(
      "SELECT id,name,anonymous,avatar_seed FROM participants WHERE id=ANY($1::uuid[])",
      [ids],
    )
  ).rows;
  return new Map(
    rows.map((p) => [
      p.id as string,
      {
        name: p.anonymous ? "Anonymous" : (p.name as string),
        avatarSeed: p.anonymous ? "anonymous" : (p.avatar_seed as string),
      },
    ]),
  );
}

/** Raw (participant-id bearing) awards for one round, for internal joins. */
export async function roundAwards(db: Sql, roundId: string) {
  const row = (
    await db.query(
      "SELECT j.snapshot,r.opened_at,COALESCE(r.closed_at,j.created_at) closed_at FROM generation_jobs j JOIN rounds r ON r.id=j.round_id WHERE j.round_id=$1",
      [roundId],
    )
  ).rows[0];
  if (!row) return null;
  return computeAwards(row.snapshot ?? {}, new Date(row.opened_at), new Date(row.closed_at));
}

/** Public awards for a published release; contributor identities respect anonymity. */
export async function releaseAwards(db: Sql, releaseId: string) {
  const row = (
    await db.query(
      `SELECT j.snapshot,r.opened_at,COALESCE(r.closed_at,j.created_at) closed_at
       FROM releases rel JOIN generation_jobs j ON j.id=rel.job_id JOIN rounds r ON r.id=j.round_id
       WHERE rel.id=$1 AND rel.published_at IS NOT NULL AND NOT rel.hidden`,
      [releaseId],
    )
  ).rows[0];
  requireThat(row, "not_found", "Track not found.", 404);
  const { stats, awards } = computeAwards(
    row.snapshot ?? {},
    new Date(row.opened_at),
    new Date(row.closed_at),
  );
  const names = await displayNames(db, [...new Set(awards.map((a) => a.authorId))]);
  return {
    rules: AWARD_RULES,
    stats,
    awards: awards.map((a) => ({
      kind: a.kind,
      label: AWARD_LABELS[a.kind],
      text: a.text,
      evidence: a.evidence,
      contributor: names.get(a.authorId)?.name ?? "Anonymous",
      avatarSeed: names.get(a.authorId)?.avatarSeed ?? "anonymous",
    })),
  };
}
