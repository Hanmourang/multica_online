import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { composeGroupFaces, GroupCompositeAvatar } from "./group-composite-avatar";

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId, actorType }: { actorId: string; actorType: string }) => (
    <span data-testid="face" data-actor-id={actorId} data-actor-type={actorType} />
  ),
}));

describe("composeGroupFaces", () => {
  const member = (id: string) => ({ type: "member" as const, id });
  const agent = (id: string) => ({ type: "agent" as const, id });

  it("grows with each added member and keeps one agent cell", () => {
    expect(composeGroupFaces([member("me")])).toEqual([member("me")]);
    expect(composeGroupFaces([member("me"), member("a")], [agent("bot")])).toEqual([
      member("me"),
      member("a"),
      agent("bot"),
    ]);
    expect(
      composeGroupFaces(
        [member("me"), member("a"), member("b"), member("c")],
        [agent("bot")],
      ).map((face) => face.id),
    ).toEqual(["me", "a", "b", "bot"]);
  });
});

describe("GroupCompositeAvatar", () => {
  it("renders one cell per face, capped at four", () => {
    render(
      <GroupCompositeAvatar
        faces={[
          { type: "member", id: "a" },
          { type: "member", id: "b" },
          { type: "member", id: "c" },
          { type: "agent", id: "d" },
          { type: "agent", id: "e" },
        ]}
        label="Group"
      />,
    );
    expect(screen.getAllByTestId("face").map((node) => node.getAttribute("data-actor-id"))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(screen.getByRole("img", { name: "Group" })).toBeInTheDocument();
  });
});
