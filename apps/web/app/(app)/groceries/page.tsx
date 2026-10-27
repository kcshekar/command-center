"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiErrorMessage } from "@/lib/api";
import { lifeApi, type GroceryItem } from "@/lib/life-api";
import { cn } from "@/lib/utils";

// R7 — running grocery list. Type "atta 5kg, butter, milk" to add several at
// once; tap to mark bought (bought items stay visible for 3 days to undo).
// The Grocery list automation posts the open list on Saturday mornings.

export default function GroceriesPage() {
  const [items, setItems] = useState<GroceryItem[] | null>(null);
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);

  async function refresh() {
    try { setItems(await lifeApi.groceries()); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not load the list")); setItems([]); }
  }
  useEffect(() => { void refresh(); }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setAdding(true);
    try { await lifeApi.addGroceries(text); setText(""); await refresh(); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not add")); }
    finally { setAdding(false); }
  }

  async function toggle(i: GroceryItem) {
    setItems((prev) => prev?.map((x) => x.id === i.id ? { ...x, done: !x.done } : x) ?? prev);
    try { await lifeApi.setGroceryDone(i.id, !i.done); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not save")); void refresh(); }
  }

  async function remove(i: GroceryItem) {
    setItems((prev) => prev?.filter((x) => x.id !== i.id) ?? prev);
    try { await lifeApi.deleteGrocery(i.id); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not remove")); void refresh(); }
  }

  const open = (items ?? []).filter((i) => !i.done);
  const bought = (items ?? []).filter((i) => i.done);

  return (
    <div className="flex max-w-xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">Groceries</h1>
        <p className="text-sm text-muted-foreground">
          {items === null ? "Loading…" : `${open.length} to buy.`} Add several at once with commas.{" "}
          <Link href="/automations/r7.groceries" className="font-medium text-primary">Saturday list</Link>
        </p>
      </div>

      <form onSubmit={add} className="flex gap-2">
        <Input aria-label="Add items" value={text} onChange={(e) => setText(e.target.value)} placeholder="atta 5kg, butter, milk" className="h-10" />
        <Button type="submit" className="h-10" disabled={adding}>Add</Button>
      </form>

      {items !== null && open.length === 0 && <p className="text-sm text-muted-foreground">Nothing to buy. Add items as you run out.</p>}

      <ul className="flex flex-col divide-y rounded-xl border bg-card empty:hidden">
        {open.map((i) => <Row key={i.id} item={i} onToggle={toggle} onRemove={remove} />)}
      </ul>

      {bought.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Bought recently</h2>
          <ul className="flex flex-col divide-y rounded-xl border bg-card">
            {bought.map((i) => <Row key={i.id} item={i} onToggle={toggle} onRemove={remove} />)}
          </ul>
        </section>
      )}
    </div>
  );
}

function Row({ item, onToggle, onRemove }: { item: GroceryItem; onToggle: (i: GroceryItem) => void; onRemove: (i: GroceryItem) => void }) {
  return (
    <li className="flex items-center gap-2 pr-2">
      <button onClick={() => onToggle(item)} aria-pressed={item.done} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left">
        <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md border-2", item.done ? "border-primary bg-primary text-primary-foreground" : "border-border")}>
          {item.done && <Check className="size-3.5" />}
        </span>
        <span className={cn("min-w-0 [overflow-wrap:anywhere]", item.done && "text-muted-foreground line-through")}>{item.name}</span>
      </button>
      <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item)}>
        <X className="size-4" />
      </Button>
    </li>
  );
}
