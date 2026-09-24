import { redirect } from "next/navigation";

/**
 * The app has one home. `/dashboard` is where the daily digest and quota usage
 * live (section 10).
 */
export default function RootPage() {
  redirect("/dashboard");
}
