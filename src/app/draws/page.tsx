"use client";

import { Typography } from "@heroui/react";
import DrawsList from "@/components/DrawsList";
import { AppShell } from "@/components/AppShell";

export default function DrawsPage() {
  return (
    <AppShell title="Draws">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10 pt-8 sm:pt-10 pb-12 flex flex-col gap-6">
        <div className="max-w-3xl">
          <Typography type="h4">Draw history</Typography>
          <Typography type="body-sm" color="muted" className="mt-1.5 text-pretty">
            Each round, eligible holders are drawn at random using drand, public randomness no
            one here controls.
          </Typography>
        </div>
        <DrawsList className="flex flex-col" />
      </div>
    </AppShell>
  );
}