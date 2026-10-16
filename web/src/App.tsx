import { Component, type ReactNode } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Layout } from './components/Layout';
import { CourtPage } from './pages/CourtPage';
import { DashboardPage } from './pages/DashboardPage';
import { FacilitySetupPage } from './pages/FacilitySetupPage';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PersonPage } from './pages/PersonPage';
import { RecordPage } from './pages/RecordPage';
import { ScorePage } from './pages/ScorePage';
import { SetupPage } from './pages/SetupPage';
import { MatchmakingPage } from './pages/MatchmakingPage';
import { PlayerPage } from './pages/PlayerPage';
import { PlayersPage } from './pages/PlayersPage';
import { ResultPage } from './pages/ResultPage';
import { SamplePlayerReportPage } from './pages/SamplePlayerReportPage';
import { SettingsPage } from './pages/SettingsPage';
import { WatchPage } from './pages/WatchPage';

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <p className="p-8">This page hit an error. Reload it. Nếu trang lỗi, hãy tải lại.</p>;
    }
    return this.props.children;
  }
}

const router = createBrowserRouter([
  { path: '/score/:token', element: <ScorePage /> },
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'court/:courtId', element: <CourtPage /> },
      { path: 'setup', element: <SetupPage /> },
      { path: 'record/:token', element: <RecordPage /> },
      { path: 'watch/:token', element: <WatchPage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'facility/setup', element: <FacilitySetupPage /> },
      { path: 'players', element: <PlayersPage /> },
      { path: 'players/sample-report', element: <SamplePlayerReportPage /> },
      { path: 'players/:playerId', element: <PlayerPage /> },
      { path: 'matches/:matchId', element: <ResultPage /> },
      { path: 'matchmaking', element: <MatchmakingPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'people/:personId', element: <PersonPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return (
    <Boundary>
      <RouterProvider router={router} />
    </Boundary>
  );
}
