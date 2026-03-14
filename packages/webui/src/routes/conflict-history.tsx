import { useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatRelativeTime } from '@/lib/time';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  RotateCcw,
} from 'lucide-react';

export const Route = createFileRoute('/conflict-history')({
  component: ConflictHistoryPage,
});

const PAGE_SIZE = 25;

function ConflictHistoryPage() {
  const trpc = useTRPC();
  const [page, setPage] = useState(0);
  const [showClient, setShowClient] = useState(false);
  const [removedTrackerFilter, setRemovedTrackerFilter] = useState('all');
  const [candidateTrackerFilter, setCandidateTrackerFilter] = useState('all');

  const { data: filterOptions } = useSuspenseQuery(
    trpc.conflictHistory.filters.queryOptions(),
  );

  const removedFilterValue =
    removedTrackerFilter === 'all' ? undefined : removedTrackerFilter;
  const candidateFilterValue =
    candidateTrackerFilter === 'all' ? undefined : candidateTrackerFilter;

  const queryInput = useMemo(
    () => ({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      removedTracker: removedFilterValue,
      candidateTracker: candidateFilterValue,
      includeClientInfo: showClient,
    }),
    [page, removedFilterValue, candidateFilterValue, showClient],
  );

  const query = useSuspenseQuery(
    trpc.conflictHistory.list.queryOptions(queryInput),
  );
  const { data, isFetching } = query;

  useEffect(() => {
    if (page * PAGE_SIZE < data.total) return;
    if (data.total === 0) {
      setPage(0);
      return;
    }
    const newPage = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1);
    if (newPage !== page) {
      setPage(newPage);
    }
  }, [data.total, page]);

  useEffect(() => {
    setPage(0);
  }, [removedTrackerFilter, candidateTrackerFilter]);

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const canGoPrev = page > 0;
  const canGoNext = (page + 1) * PAGE_SIZE < data.total;
  const items = data.items;
  const rangeStart = data.total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = data.total === 0 ? 0 : page * PAGE_SIZE + items.length;

  const truncateHash = (hash: string) =>
    hash.length > 12 ? `${hash.slice(0, 6)}...${hash.slice(-6)}` : hash;

  const renderTracker = (trackers?: string[]) => {
    if (!trackers?.length) return 'Unknown';
    if (trackers.length === 1) return trackers[0];

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help">{trackers[0]}, ...</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-80 break-words">
          {trackers.join(', ')}
        </TooltipContent>
      </Tooltip>
    );
  };

  return (
    <Page breadcrumbs={['Conflict History']}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">Conflict History</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            Showing {rangeStart}-{rangeEnd} of {data.total} removal events
          </p>
        </div>
        <div className="bg-muted/30 text-muted-foreground flex flex-col gap-3 rounded-lg border px-3 py-2 text-sm lg:flex-row lg:items-center lg:gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => {
                      setRemovedTrackerFilter('all');
                      setCandidateTrackerFilter('all');
                    }}
                    disabled={
                      removedTrackerFilter === 'all' &&
                      candidateTrackerFilter === 'all'
                    }
                  >
                    <span className="sr-only">Reset filters</span>
                    <RotateCcw className="size-4" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                Reset filters
              </TooltipContent>
            </Tooltip>
            <Select
              value={removedTrackerFilter}
              onValueChange={setRemovedTrackerFilter}
            >
              <SelectTrigger size="sm" className="min-w-[200px]">
                <SelectValue placeholder="Removed from tracker" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All removed trackers</SelectItem>
                {filterOptions.removedTrackers.map((tracker) => (
                  <SelectItem key={tracker} value={tracker}>
                    {tracker}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={candidateTrackerFilter}
              onValueChange={setCandidateTrackerFilter}
            >
              <SelectTrigger size="sm" className="min-w-[200px]">
                <SelectValue placeholder="Injected to tracker" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All injected trackers</SelectItem>
                {filterOptions.candidateTrackers.map((tracker) => (
                  <SelectItem key={tracker} value={tracker}>
                    {tracker}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowClient((prev) => !prev)}
            >
              {showClient ? 'Hide client info' : 'Show client info'}
            </Button>
          </div>
          <div className="bg-border hidden h-4 w-px lg:block" />
          <div className="flex items-center gap-2 text-sm font-medium">
            <span>
              Page {Math.min(page + 1, totalPages)} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="hidden h-7 w-7 p-0 lg:flex"
                onClick={() => setPage(0)}
                disabled={!canGoPrev || isFetching}
              >
                <span className="sr-only">Go to first page</span>
                <ChevronsLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={() => setPage((prev) => Math.max(0, prev - 1))}
                disabled={!canGoPrev || isFetching}
              >
                <span className="sr-only">Go to previous page</span>
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={() => setPage((prev) => prev + 1)}
                disabled={!canGoNext || isFetching}
              >
                <span className="sr-only">Go to next page</span>
                <ChevronRight className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="hidden h-7 w-7 p-0 lg:flex"
                onClick={() => setPage(totalPages - 1)}
                disabled={!canGoNext || isFetching}
              >
                <span className="sr-only">Go to last page</span>
                <ChevronsRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader className="bg-muted sticky top-0 z-10">
            <TableRow className="border-b">
              <TableHead>Name</TableHead>
              <TableHead>Info Hash</TableHead>
              <TableHead>Removed Tracker</TableHead>
              <TableHead>Injected Tracker</TableHead>
              <TableHead>Conflict Rule</TableHead>
              <TableHead>Date</TableHead>
              {showClient && <TableHead>Client Info</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={showClient ? 7 : 6}
                  className="py-10 text-center"
                >
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-muted-foreground text-sm">
                      No conflict removals recorded.
                    </span>
                    <span className="text-muted-foreground text-xs">
                      Removals appear when conflict rules are applied to replace
                      lower-priority seeders.
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="max-w-[200px] truncate font-medium">
                    {item.searcheeName}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <Tooltip>
                      <TooltipTrigger>
                        {truncateHash(item.infoHash)}
                      </TooltipTrigger>
                      <TooltipContent>{item.infoHash}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>{renderTracker(item.removedTrackers)}</TableCell>
                  <TableCell>{renderTracker(item.candidateTrackers)}</TableCell>
                  <TableCell>
                    <span className="text-sm">
                      Level {item.appliedRulePriority + 1}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {formatRelativeTime(item.timestamp)}
                  </TableCell>
                  {showClient && (
                    <TableCell className="text-xs">
                      <div className="space-y-1">
                        {item.removedClientHost && (
                          <div>
                            <span className="text-muted-foreground">
                              Removed:{' '}
                            </span>
                            {item.removedClientHost}
                          </div>
                        )}
                        {item.injectedClientHost && (
                          <div>
                            <span className="text-muted-foreground">
                              Injected:{' '}
                            </span>
                            {item.injectedClientHost}
                          </div>
                        )}
                        {!item.removedClientHost &&
                          !item.injectedClientHost && (
                            <span className="text-muted-foreground">N/A</span>
                          )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </Page>
  );
}
