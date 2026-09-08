import { expect, it } from "vitest";
import crons from "./crons";

it("checks solvency and index lag every five minutes", () => {
  const jobs = crons.crons;
  expect(jobs["check vault solvency and index lag"].schedule).toEqual({ type: "interval", minutes: 5 });
});
