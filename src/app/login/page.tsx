import { redirect } from "next/navigation";
import { Flash, param } from "@/components/ui";
import { authEnabled } from "@/lib/auth";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  if (!authEnabled()) redirect("/");
  const next = param(sp, "next") ?? "/";

  return (
    <div className="mx-auto mt-16 max-w-sm">
      <Flash sp={sp} />
      <form action="/auth/login" method="post" className="card space-y-4">
        <h1 className="text-lg font-semibold">Sign in</h1>
        <input type="hidden" name="next" value={next} />
        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input id="password" name="password" type="password" className="input" autoFocus required />
        </div>
        <button className="btn w-full justify-center">Sign in</button>
      </form>
    </div>
  );
}
