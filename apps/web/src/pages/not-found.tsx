import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export default function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">404</h1>
        <p className="text-muted-foreground text-sm">页面不存在</p>
      </div>
      <Button render={<Link to="/" />} nativeButton={false}>
        返回首页
      </Button>
    </div>
  );
}
