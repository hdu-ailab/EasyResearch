import { createEventWorkerBroker, type EventPort } from "./event-worker-broker";

const broker = createEventWorkerBroker();
const scope = self as unknown as { onconnect: ((event: MessageEvent & { ports: EventPort[] }) => void) | null };
scope.onconnect = (event) => {
  const port = event.ports[0];
  if (port) broker.attach(port);
};
