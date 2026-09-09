import { AgentError } from "./errors.js";
import type { AgentState } from "./types.js";

export interface ReconciliationStreamWatermark {
  producerEpoch: string;
  throughHostSeq: number;
}

export interface ResumeStreamWatermark {
  producerEpoch: string;
  firstRetainedHostSeq: number;
  lastProducedHostSeq: number;
  lastAckedHostSeq: number;
}

export interface SelectedDurableStreams {
  reconciliationStreams: ReconciliationStreamWatermark[];
  resumeStreams: ResumeStreamWatermark[];
}

const MAX_RECONCILIATION_STREAMS = 32;

/**
 * Selects the exact bounded stream set used by both hello.resumeStreams and
 * hello.reconciliationStreams. Fully acknowledged historical epochs are not
 * relevant; an old epoch with retained events can never be silently sliced.
 */
export function selectDurableStreams(state: AgentState, currentProducerEpoch: string): SelectedDurableStreams {
  const current = state.producerStreams[currentProducerEpoch];
  if (!current) {
    throw new AgentError("CURRENT_PRODUCER_STREAM_MISSING", "the current producer epoch has no durable stream");
  }

  const firstRetainedByEpoch = new Map<string, number>();
  for (const event of state.outbox) {
    const stream = state.producerStreams[event.producerEpoch];
    if (!stream) {
      throw new AgentError("OUTBOX_STREAM_MISSING", "an outbox event references a missing producer stream");
    }
    const retained = firstRetainedByEpoch.get(event.producerEpoch);
    if (retained === undefined || event.hostSeq < retained) {
      firstRetainedByEpoch.set(event.producerEpoch, event.hostSeq);
    }
  }

  const retainedOldEpochs = [...firstRetainedByEpoch.keys()]
    .filter((producerEpoch) => producerEpoch !== currentProducerEpoch)
    .sort((left, right) => left.localeCompare(right));
  if (retainedOldEpochs.length > MAX_RECONCILIATION_STREAMS - 1) {
    throw new AgentError(
      "RECONCILIATION_STREAM_LIMIT_EXCEEDED",
      `durable outbox spans ${retainedOldEpochs.length} old producer epochs; at most ${MAX_RECONCILIATION_STREAMS - 1} can be reconciled safely`,
    );
  }

  const resumeStreams = retainedOldEpochs.map((producerEpoch) => {
    const stream = state.producerStreams[producerEpoch];
    const firstRetainedHostSeq = firstRetainedByEpoch.get(producerEpoch);
    if (!stream || firstRetainedHostSeq === undefined) {
      throw new AgentError("OUTBOX_STREAM_MISSING", "a selected producer stream has no retained events");
    }
    return {
      producerEpoch,
      firstRetainedHostSeq,
      lastProducedHostSeq: stream.lastProducedSeq,
      lastAckedHostSeq: stream.lastAckedSeq,
    };
  });

  return {
    reconciliationStreams: [
      { producerEpoch: currentProducerEpoch, throughHostSeq: current.lastProducedSeq },
      ...resumeStreams.map(({ producerEpoch, lastProducedHostSeq }) => ({
        producerEpoch,
        throughHostSeq: lastProducedHostSeq,
      })),
    ],
    resumeStreams,
  };
}
