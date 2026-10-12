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
import { CatalogPage } from './pages/CatalogPage.jsx';
import { SuppliersPage } from './pages/SuppliersPage.jsx';
import { InventoryPage } from './pages/InventoryPage.jsx';
import { CustomersPage } from './pages/CustomersPage.jsx';
import { ProcurementPage } from './pages/ProcurementPage.jsx';
import { TransfersPage } from './pages/TransfersPage.jsx';
import { RequestsPage } from './pages/RequestsPage.jsx';
import { TillPage } from './pages/TillPage.jsx';
import { SalesPage, TicketPage } from './pages/SalesPage.jsx';
import { FinancePage } from './pages/FinancePage.jsx';
import { RecipesPage } from './pages/RecipesPage.jsx';
import { ProductionPage } from './pages/ProductionPage.jsx';
import { FrontDeskPage } from './pages/FrontDeskPage.jsx';
import { ReservationPage } from './pages/ReservationPage.jsx';
import { AppointmentsPage } from './pages/AppointmentsPage.jsx';
import { AppointmentPage } from './pages/AppointmentPage.jsx';
import { PartnershipPage } from './pages/PartnershipPage.jsx';

function Gate() {
  const { me, loadError, refresh } = useSession();
  if (me === undefined && loadError) {
    return (
      <div className="auth-screen">
        <div className="card auth-card">
          <h2>Can't reach the server</h2>
          <p className="muted">{loadError.message}</p>
          <button className="primary" onClick={refresh}>Try again</button>
        </div>
      </div>
    );
  }
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
        <Route path="/catalog" element={<CatalogPage />} />
        <Route path="/suppliers" element={<SuppliersPage />} />
        <Route path="/inventory" element={<InventoryPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/procurement" element={<ProcurementPage />} />
        <Route path="/transfers" element={<TransfersPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/till" element={<TillPage />} />
        <Route path="/sales" element={<SalesPage />} />
        <Route path="/sales/:unitId/:id" element={<TicketPage />} />
        <Route path="/books" element={<FinancePage />} />
        <Route path="/recipes" element={<RecipesPage />} />
        <Route path="/production" element={<ProductionPage />} />
        <Route path="/front-desk" element={<FrontDeskPage />} />
        <Route path="/front-desk/:unitId/reservations/:id" element={<ReservationPage />} />
        <Route path="/appointments" element={<AppointmentsPage />} />
        <Route path="/appointments/:unitId/:id" element={<AppointmentPage />} />
        <Route path="/partnership" element={<PartnershipPage />} />
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
