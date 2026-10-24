import { Component, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

/** Shows a screen's error instead of letting it close the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <ScrollView contentContainerStyle={{ padding: 20, gap: 10 }}>
        <Text style={{ fontSize: 20, fontWeight: '800', color: '#B3261E' }}>Something went wrong on this screen</Text>
        <Text style={{ fontSize: 15, color: '#4D5068' }}>
          Switch to another tab and back to retry. If it keeps happening, send a screenshot of this message.
        </Text>
        <View style={{ backgroundColor: '#F7E3E6', borderRadius: 12, padding: 12 }}>
          <Text selectable style={{ fontFamily: 'monospace', fontSize: 12, color: '#191A2E' }}>
            {this.state.error.message}
          </Text>
        </View>
      </ScrollView>
    );
  }
}
