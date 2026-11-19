import { fixtureRoundTrip } from "./worker.ts";

fixtureRoundTrip(process.cwd()).then(console.log, (error) => {
  console.error(error);
  process.exitCode = 1;
});
