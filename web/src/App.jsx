import { Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './session.jsx';
import { Layout } from './components/Layout.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { ChangePasswordPage } from './pages/ChangePasswordPage.jsx';
import { DashboardPage } from './pages/DashboardPage.jsx';
import { OrganisationPage } from './pages/OrganisationPage.jsx';
import { UsersPage } from './pages/UsersPage.jsx';
import { ApprovalsPage } from './pages/ApprovalsPage.jsx';
import { AuditPage } from './pages/AuditPage.jsx';

function Gate() {
  const { me } = useSession();
  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (me === null) return <LoginPage />;
  if (me.user.must_change_password) return <ChangePasswordPage forced />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/organisation" element={<OrganisationPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/account/password" element={<ChangePasswordPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export function App() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}
