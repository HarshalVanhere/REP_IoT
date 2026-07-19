import React from 'react';

function Bar({ className = '' }) {
  return <div className={`animate-pulse bg-slate-200/70 rounded-lg ${className}`}></div>;
}

/**
 * Shown in place of the dashboard while the first /api/machines + /api/reports round-trip
 * is in flight, so the UI never flashes a false "no machines found" empty state on load.
 */
export default function DashboardSkeleton() {
  return (
    <div className="space-y-8 w-full" aria-busy="true" aria-label="Loading dashboard data">
      <div className="jbm-card p-6 space-y-4">
        <Bar className="h-5 w-64" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mt-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="p-4 border border-[var(--grey-200)] rounded-2xl space-y-3">
              <Bar className="h-3 w-24" />
              <Bar className="h-7 w-20" />
              <Bar className="h-3 w-32" />
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <div key={i} className="jbm-card p-6 space-y-4 min-h-[420px]">
            <div className="flex justify-between items-start">
              <Bar className="h-4 w-32" />
              <Bar className="h-6 w-20 rounded-full" />
            </div>
            <Bar className="h-24 w-24 rounded-full mx-auto" />
            <Bar className="h-3 w-full" />
            <Bar className="h-3 w-3/4" />
            <Bar className="h-12 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
