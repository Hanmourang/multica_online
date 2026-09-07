import { cn } from "@multica/ui/lib/utils";

export function StageDots({
  states,
}: {
  states: Array<"done" | "on" | "bad" | "todo">;
}) {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {states.map((state, i) => (
        <i
          key={i}
          className={cn(
            "size-2 rounded-full",
            state === "done" && "bg-emerald-500",
            state === "on" && "bg-primary shadow-[0_0_0_3px] shadow-primary/20",
            state === "bad" && "bg-destructive",
            state === "todo" && "bg-muted",
          )}
        />
      ))}
    </span>
  );
}
