import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the studio tabs', () => {
  render(<App />);
  expect(screen.getByText(/lake reflections/i)).toBeInTheDocument();
  expect(screen.getByText(/glass closeups/i)).toBeInTheDocument();
});
