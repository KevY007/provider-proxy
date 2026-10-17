import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Card frame shared by all auth pages. */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Card className="w-full max-w-md border-border/60 shadow-xl shadow-black/5">
      <CardHeader className="space-y-1.5 text-center">
        <CardTitle className="text-2xl">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-6">
        {children}
        {footer && <div className="text-center text-sm text-muted-foreground">{footer}</div>}
      </CardContent>
    </Card>
  );
}
