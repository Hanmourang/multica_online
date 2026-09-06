"use client";

import { ErrorBoundary } from "@multica/ui/components/common/error-boundary";
import { CalendarPage } from "@multica/views/calendar";

export default function Page() {
  return (
    <ErrorBoundary>
      <CalendarPage />
    </ErrorBoundary>
  );
}
