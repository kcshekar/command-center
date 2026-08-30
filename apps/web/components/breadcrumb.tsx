import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && <ChevronRight className="size-3.5 shrink-0" />}
            {item.href && !isLast ? (
              <Link href={item.href} className="truncate hover:text-foreground">
                {item.label}
              </Link>
            ) : (
              <span className={isLast ? "truncate font-medium text-foreground" : "truncate"}>{item.label}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
