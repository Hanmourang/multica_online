"use client";

import { useState } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { useT } from "../../../i18n";
import {
  applyDomainLayout,
  type BusMatrixLayout,
  type ManualRegisterRow,
} from "./bus-matrix-layout";

/** C4 人工管理控制台：域展示 / 行隐藏 / 手工登记。全部只写展示配置。 */
export function BusMatrixManage({
  projectId,
  domains,
  layout,
  onChange,
}: {
  projectId: string;
  domains: string[];
  layout: BusMatrixLayout;
  onChange: (next: BusMatrixLayout) => void;
}) {
  const { t } = useT("archive");
  const [name, setName] = useState("");
  const [domain, setDomain] = useState(domains[0] ?? "");
  const [read, setRead] = useState("0");
  const [write, setWrite] = useState("0");
  const visible = applyDomainLayout(domains, layout);

  const addManual = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const row: ManualRegisterRow = {
      id: `manual-${Date.now()}`,
      name: trimmed,
      domain: domain || domains[0] || "unmapped",
      read: Number(read) || 0,
      write: Number(write) || 0,
    };
    onChange({ ...layout, manualRows: [...layout.manualRows, row] });
    setName("");
  };

  return (
    <div
      className="grid gap-3 rounded-lg border border-dashed border-surface-border bg-surface p-3 sm:grid-cols-3"
      data-testid="bus-matrix-manage"
    >
      <section>
        <div className="text-caption font-medium">{t(($) => $.bus_manage.domain_title)}</div>
        <p className="mb-2 text-micro text-muted-foreground">
          {t(($) => $.bus_manage.domain_hint)}
        </p>
        <ul className="space-y-1">
          {visible.map((item) => (
            <li key={item} className="flex items-center gap-1.5 text-caption">
              <span className="min-w-0 flex-1 truncate">
                {layout.aliases[item] ?? item}
              </span>
              <button
                type="button"
                className="text-micro text-muted-foreground hover:text-foreground"
                onClick={() => {
                  const next = window.prompt(
                    t(($) => $.bus_manage.rename_prompt),
                    layout.aliases[item] ?? item,
                  );
                  if (!next) return;
                  onChange({
                    ...layout,
                    aliases: { ...layout.aliases, [item]: next.trim() },
                  });
                }}
              >
                {t(($) => $.bus_manage.rename)}
              </button>
              <button
                type="button"
                className="text-micro text-muted-foreground hover:text-destructive"
                onClick={() =>
                  onChange({
                    ...layout,
                    hiddenDomains: [...layout.hiddenDomains, item],
                  })
                }
              >
                {t(($) => $.bus_manage.hide)}
              </button>
            </li>
          ))}
        </ul>
        {layout.hiddenDomains.length > 0 && (
          <Button
            size="xs"
            variant="ghost"
            className="mt-1"
            onClick={() => onChange({ ...layout, hiddenDomains: [] })}
          >
            {t(($) => $.bus_manage.show_all)}
          </Button>
        )}
      </section>

      <section>
        <div className="text-caption font-medium">{t(($) => $.bus_manage.row_title)}</div>
        <p className="mb-2 text-micro text-muted-foreground">
          {t(($) => $.bus_manage.row_hint)}
        </p>
        <p className="text-micro text-muted-foreground">
          {t(($) => $.bus_manage.row_note)}
        </p>
      </section>

      <section>
        <div className="text-caption font-medium">{t(($) => $.bus_manage.manual_title)}</div>
        <p className="mb-2 text-micro text-muted-foreground">
          {t(($) => $.bus_manage.manual_hint)}
        </p>
        <div className="space-y-1.5">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t(($) => $.bus_manage.manual_name)}
            className="h-8 text-caption"
          />
          <select
            className="h-8 w-full rounded-md border border-surface-border bg-surface px-2 text-caption"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          >
            {domains.map((item) => (
              <option key={item} value={item}>
                {layout.aliases[item] ?? item}
              </option>
            ))}
          </select>
          <div className="flex gap-1.5">
            <Input
              value={read}
              onChange={(e) => setRead(e.target.value)}
              className="h-8 text-caption"
              aria-label="R"
            />
            <Input
              value={write}
              onChange={(e) => setWrite(e.target.value)}
              className="h-8 text-caption"
              aria-label="W"
            />
          </div>
          <Button size="xs" onClick={addManual} disabled={!name.trim()}>
            {t(($) => $.bus_manage.manual_add)}
          </Button>
        </div>
        {layout.manualRows.length > 0 && (
          <ul className="mt-2 space-y-1">
            {layout.manualRows.map((row) => (
              <li key={row.id} className="flex items-center gap-2 text-caption">
                <span className="rounded bg-muted px-1 text-micro">
                  {t(($) => $.bus_manage.manual_badge)}
                </span>
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                <button
                  type="button"
                  className="text-micro text-destructive"
                  onClick={() =>
                    onChange({
                      ...layout,
                      manualRows: layout.manualRows.filter((r) => r.id !== row.id),
                    })
                  }
                >
                  {t(($) => $.features.delete)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <span className="sr-only">{projectId}</span>
    </div>
  );
}
