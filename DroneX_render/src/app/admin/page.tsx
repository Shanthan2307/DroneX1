// The admin dashboard, behind a PIN (lib/admin.ts). Composition only.
import AdminDashboard from "@/components/admin/AdminDashboard";

export const metadata = { title: "DroneX admin", robots: { index: false, follow: false } };

export default function AdminPage() {
  return <AdminDashboard />;
}
