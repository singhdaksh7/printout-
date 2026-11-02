import { Link } from 'react-router-dom';
import { Banner, BrandLogo, Card } from '../ui';

/** Shown instead of redirecting when an administrator session reaches a shop route, so Back never lands on an admin page by accident. */
export function AdminSessionNotice() {
  return (
    <div className="pb-theme pb-login">
      <div className="pb-login__brand"><BrandLogo /></div>
      <Card as="section" className="pb-login__card">
        <div className="pb-login__form">
          <h1 className="pb-h1">Administrator account</h1>
          <Banner tone="info">You are signed in as an administrator, which has no shop dashboard.</Banner>
          <Link to="/admin">Go to the admin console</Link>
        </div>
      </Card>
    </div>
  );
}
