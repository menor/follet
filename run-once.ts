// A test that now I can run the core from different renderer engines
import { createAgent, type AgentState } from "./main";

const prompt =
  process.argv[2] ?? "List the files in ./sandbox/run and summarise them.";

let state: AgentState = {
  messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  status: "thinking",
};

const { runStep } = createAgent()

while (state.status === "thinking") {
  state = await runStep(state);
}

console.log(JSON.stringify(state, null, 2));
