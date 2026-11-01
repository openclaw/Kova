import { sessionFlows } from "./control-ui-session-flows.mjs";
import { chatFlows } from "./control-ui-chat-flows.mjs";

export const controlUiFlows = Object.freeze({ ...sessionFlows, ...chatFlows });
