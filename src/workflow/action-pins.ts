import type { AgentKind } from "./contracts.js";
import {
  AGENT_ACTION_REPOSITORIES,
  type PinnedAction,
  UPLOAD_ARTIFACT_ACTION_REPOSITORY,
} from "./templates.js";

/** Reviewable deployment data for every third-party action emitted by the CLI. */
export const CHECKOUT_ACTION: PinnedAction = {
  repository: "actions/checkout",
  sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
  version: "v7",
};

export const AGENT_ACTIONS: Readonly<Record<AgentKind, PinnedAction>> = {
  claude: {
    repository: AGENT_ACTION_REPOSITORIES.claude,
    sha: "be7b93b1907a4abad570368f3c74b6fe3807510b",
    version: "v1",
  },
  codex: {
    repository: AGENT_ACTION_REPOSITORIES.codex,
    sha: "52fe01ec70a42f454c9d2ebd47598f9fd6893d56",
    version: "v1",
  },
};

export const UPLOAD_ARTIFACT_ACTION: PinnedAction = {
  repository: UPLOAD_ARTIFACT_ACTION_REPOSITORY,
  sha: "ea165f8d65b6e75b540449e92b4886f43607fa02",
  version: "v4.6.2",
};
