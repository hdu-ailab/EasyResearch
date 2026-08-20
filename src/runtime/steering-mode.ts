export interface RuntimeSteeringSession {
  agent: { steeringMode: "all" | "one-at-a-time" };
}

export function configureBatchedSteering(session: RuntimeSteeringSession): void {
  session.agent.steeringMode = "all";
}
