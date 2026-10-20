import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useApp } from './app-context.js';
import { AdminShell, AttendantShell } from './components/Shell.js';
import { Auth } from './screens/Auth.js';
import { AiSettings, LocaleSettings } from './screens/Settings.js';
import { AttendantHome, CheckInCapture, CheckInConfirm, CheckInReview, CheckOut, Flow } from './screens/Attendant.js';
import { Dashboard } from './screens/Dashboard.js';
import { Inventory } from './screens/Inventory.js';
import { Queue } from './screens/Queue.js';
import { Rates } from './screens/Rates.js';
import { Sessions } from './screens/Sessions.js';
import { Slots } from './screens/Slots.js';

function Gate({ children }: { children: JSX.Element }) {
  const { me } = useApp();
  const { slug } = useParams();
  if (!me) return <Navigate to="/login" replace />;
  if (slug && slug !== me.tenant.slug) return <Navigate to={`/t/${me.tenant.slug}`} replace />;
  return children;
}

function Home() {
  const { me } = useApp();
  if (!me) return <Navigate to="/login" replace />;
  return <Navigate to={`/t/${me.tenant.slug}/${me.role === 'attendant' ? 'a' : 'dashboard'}`} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Auth mode="login" />} />
      <Route path="/signup" element={<Auth mode="signup" />} />
      <Route path="/t/:slug" element={<Gate><AdminShell /></Gate>}>
        <Route index element={<Home />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="sessions" element={<Sessions />} />
        <Route path="slots" element={<Slots />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="rates" element={<Rates />} />
        <Route path="ai" element={<AiSettings />} />
        <Route path="locale" element={<LocaleSettings />} />
        <Route path="queue" element={<Queue />} />
      </Route>
      <Route path="/t/:slug/a" element={<Gate><Flow><AttendantShell /></Flow></Gate>}>
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
