import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the reflection studio', () => {
  render(<App />);
  expect(screen.getByText(/reflection region studio/i)).toBeInTheDocument();
});
