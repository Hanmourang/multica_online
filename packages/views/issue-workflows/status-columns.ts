import { STATUS_ORDER } from "@multica/core/issues/config";
import type { IssueStatusCatalog } from "@multica/core/issue-statuses/queries";
import type { IssueStatus, IssueStatusCategory } from "@multica/core/types";

/**
 * Whether a category closes an issue instead of advancing it. In this repo the
 * closed category is `cancelled`; the upstream fork calls it `closed`.
 */
export function isClosedCategory(category: IssueStatusCategory): boolean {
  return category === "cancelled";
}

/**
 * Every status key in column order: the 7 categories in their fixed sequence,
 * and within a category the catalog positions.
 *
 * This repo's catalog is key-based (a built-in key IS its category), so unlike
 * the upstream fork there is no separate four-value lifecycle vocabulary to
 * normalize — the order comes straight from `STATUS_ORDER` and `position`.
 */
export function statusColumnKeys(
  catalog: Pick<IssueStatusCatalog, "statuses">,
  includeArchived = false,
): IssueStatus[] {
  const rank = (key: string) => {
    const index = STATUS_ORDER.indexOf(key as (typeof STATUS_ORDER)[number]);
    return index < 0 ? STATUS_ORDER.length : index;
  };
  return catalog.statuses
    .filter((entry) => includeArchived || !entry.archived_at)
    .slice()
    .sort((a, b) => rank(a.category) - rank(b.category) || (a.position ?? 0) - (b.position ?? 0))
    .map((entry) => entry.key as IssueStatus);
}
