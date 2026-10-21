import { Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom';
import { homeFor, useApp, type Role } from './app-context.js';
import { AppShell, AttendantLayout } from './components/Shell.js';
import { hasResidentView, isAdmin, isOperator, isOps, isStaff } from './menu.js';
import { Auth, Onboarding } from './screens/Auth.js';
import { AiSettings, LocaleSettings } from './screens/Settings.js';
import { AttendantHome, CheckInCapture, CheckInConfirm, CheckInReview, CheckOut, Flow } from './screens/Attendant.js';
import { Dashboard } from './screens/Dashboard.js';
import { GuestPass } from './screens/GuestPass.js';
import { GuestPasses } from './screens/GuestPasses.js';
import { Integrations } from './screens/Integrations.js';
import { Inventory } from './screens/Inventory.js';
import { Parking } from './screens/Parking.js';
import { People, Units } from './screens/People.js';
import { Platform } from './screens/Platform.js';
import { Queue } from './screens/Queue.js';
import { Rates } from './screens/Rates.js';
import { ResidentHome } from './screens/Resident.js';
import { Sessions } from './screens/Sessions.js';
import { Slots } from './screens/Slots.js';

/** Who may open which part of the app. The menu shows a subset of this; these guards also cover typed URLs. */
type Area = 'ops' | 'admin' | 'operator' | 'resident' | 'staff';
const allowed = (area: Area, roles: Role[], superadmin: boolean) => {
  switch (area) {
    case 'resident': return hasResidentView(roles, superadmin);
    case 'admin': return isAdmin(roles, superadmin);
    case 'ops': return isOps(roles, superadmin);
    case 'operator': return isOperator(roles, superadmin) || isStaff(roles, superadmin); // the menu offers it to attendants; supervisors and admins can still use it by link
    case 'staff': return isStaff(roles, superadmin);
  }
};

/** The URL's organisation must be the one in use; otherwise switch to it. */
function TenantGate() {
  const { me, who } = useApp();
  const { slug } = useParams();
  if (!me) return <Navigate to={homeFor(null, who)} replace />;
  if (slug && slug !== me.tenant.slug) return <Navigate to={`/t/${me.tenant.slug}`} replace />;
  return <Outlet />;
}

function Area({ area }: { area: Area }) {
  const { me, who } = useApp();
  if (!me || !allowed(area, me.roles, me.superadmin)) return <Navigate to={homeFor(me, who)} replace />;
  return <Outlet />;
}

function Home() {
  const { me, who } = useApp();
  return <Navigate to={homeFor(me, who)} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Auth mode="login" />} />
      <Route path="/signup" element={<Auth mode="signup" />} />
      <Route path="/forgot" element={<Auth mode="forgot" />} />
      <Route path="/reset" element={<Auth mode="reset" />} />
      <Route path="/onboarding" element={<Onboarding />} />
      {/* Public: a guest opens the shared link and shows this QR at the gate. No auth; the token lives only in the URL fragment. */}
      <Route path="/pass" element={<GuestPass />} />

      <Route element={<AppShell />}>
        <Route path="/platform" element={<Platform />} />
        <Route path="/t/:slug" element={<TenantGate />}>
          <Route index element={<Home />} />
          <Route element={<Area area="ops" />}>
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="sessions" element={<Sessions />} />
            <Route path="slots" element={<Slots />} />
            <Route path="passes" element={<GuestPasses />} />
          </Route>
          <Route element={<Area area="admin" />}>
            <Route path="inventory" element={<Inventory />} />
            <Route path="rates" element={<Rates />} />
            <Route path="ai" element={<AiSettings />} />
            <Route path="locale" element={<LocaleSettings />} />
            <Route path="parking" element={<Parking />} />
            <Route path="integrations" element={<Integrations />} />
            <Route path="units" element={<Units />} />
            <Route path="users" element={<People />} />
          </Route>
          <Route element={<Area area="staff" />}>
            <Route path="queue" element={<Queue />} />
          </Route>
          <Route element={<Area area="operator" />}>
            <Route path="a" element={<Flow><AttendantLayout /></Flow>}>
              <Route index element={<AttendantHome />} />
              <Route path="checkin" element={<CheckInCapture />} />
              <Route path="checkin/review" element={<CheckInReview />} />
              <Route path="checkin/confirm" element={<CheckInConfirm />} />
              <Route path="checkout" element={<CheckOut />} />
            </Route>
          </Route>
          <Route element={<Area area="resident" />}>
            <Route path="r" element={<ResidentHome />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
