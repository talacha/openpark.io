import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { homeFor, useApp } from './app-context.js';
import { AdminShell, AttendantShell, ResidentShell } from './components/Shell.js';
import { Auth, Onboarding } from './screens/Auth.js';
import { GuestPasses } from './screens/GuestPasses.js';
import { People, Units } from './screens/People.js';
import { Platform } from './screens/Platform.js';
import { ResidentHome } from './screens/Resident.js';
import { AiSettings, LocaleSettings } from './screens/Settings.js';
import { AttendantHome, CheckInCapture, CheckInConfirm, CheckInReview, CheckOut, Flow } from './screens/Attendant.js';
import { Dashboard } from './screens/Dashboard.js';
import { Inventory } from './screens/Inventory.js';
import { Queue } from './screens/Queue.js';
import { Rates } from './screens/Rates.js';
import { Sessions } from './screens/Sessions.js';
import { Slots } from './screens/Slots.js';

/** Keeps each role in its own part of the app, and the URL's tenant in step with the one in use. */
function Gate({ children, area }: { children: JSX.Element; area?: 'admin' | 'attendant' | 'resident' }) {
  const { me, who } = useApp();
  const { slug } = useParams();
  if (!me) return <Navigate to={homeFor(null, who)} replace />;
  if (slug && slug !== me.tenant.slug) return <Navigate to={`/t/${me.tenant.slug}`} replace />;
  if (area === 'resident' && me.role !== 'resident') return <Navigate to={homeFor(me, who)} replace />;
  if (area === 'admin' && me.role === 'resident') return <Navigate to={homeFor(me, who)} replace />;
  if (area === 'attendant' && me.role === 'resident') return <Navigate to={homeFor(me, who)} replace />;
  return children;
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
      <Route path="/platform" element={<Platform />} />
      <Route path="/t/:slug" element={<Gate area="admin"><AdminShell /></Gate>}>
        <Route index element={<Home />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="sessions" element={<Sessions />} />
        <Route path="slots" element={<Slots />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="rates" element={<Rates />} />
        <Route path="ai" element={<AiSettings />} />
        <Route path="locale" element={<LocaleSettings />} />
        <Route path="queue" element={<Queue />} />
        <Route path="passes" element={<GuestPasses />} />
        <Route path="units" element={<Units />} />
        <Route path="users" element={<People />} />
      </Route>
      <Route path="/t/:slug/r" element={<Gate area="resident"><ResidentShell /></Gate>}>
        <Route index element={<ResidentHome />} />
      </Route>
      <Route path="/t/:slug/a" element={<Gate area="attendant"><Flow><AttendantShell /></Flow></Gate>}>
        <Route index element={<AttendantHome />} />
        <Route path="checkin" element={<CheckInCapture />} />
        <Route path="checkin/review" element={<CheckInReview />} />
        <Route path="checkin/confirm" element={<CheckInConfirm />} />
        <Route path="checkout" element={<CheckOut />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
