// STUB created by lead — Gateway agent implements (distributed slot manager, PLAN §9b), keeping these exports.
export type SlotUsage = { id: string; label: string; inUse: number; max: number | null };

export type SlotSnapshot = {
  providerKeys: (SlotUsage & { providerId: string })[];
  providers: SlotUsage[];
  customers: SlotUsage[]; // top users by in-use slots
  queued: number;
  at: string;
};

export async function getSlotSnapshot(): Promise<SlotSnapshot> {
  return { providerKeys: [], providers: [], customers: [], queued: 0, at: new Date().toISOString() };
}
