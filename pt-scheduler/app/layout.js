import './globals.css';
export const metadata = { title: 'PT Scheduler', description: 'Personal training scheduling and billing' };
export default function RootLayout({ children }) {
  return (<html lang="en"><body>{children}</body></html>);
}
