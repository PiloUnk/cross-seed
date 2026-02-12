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

export const Route = createFileRoute('/collisions')({
  component: CollisionsPage,
});

const PAGE_SIZE = 25;

function CollisionsPage() {
  const trpc = useTRPC();
  const [page, setPage] = useState(0);
  const [showClient, setShowClient] = useState(false);
  const [candidateTrackerFilter, setCandidateTrackerFilter] = useState('all');
  const [currentTrackerFilter, setCurrentTrackerFilter] = useState('all');

  const { data: filterOptions } = useSuspenseQuery(
    trpc.searchees.collisionFilters.queryOptions(),
  );

  const candidateFilterValue =
    candidateTrackerFilter === 'all' ? undefined : candidateTrackerFilter;
  const currentFilterValue =
    currentTrackerFilter === 'all' ? undefined : currentTrackerFilter;

  const queryInput = useMemo(
    () => ({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      includeKnownTrackers: true,
      candidateTracker: candidateFilterValue,
      currentTracker: currentFilterValue,
    }),
    [page, candidateFilterValue, currentFilterValue],
  );

  const query = useSuspenseQuery(
    trpc.searchees.candidates.queryOptions(queryInput),
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
  }, [candidateTrackerFilter, currentTrackerFilter]);

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const canGoPrev = page > 0;
  const canGoNext = (page + 1) * PAGE_SIZE < data.total;
  const items = data.items;
  const rangeStart = data.total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = data.total === 0 ? 0 : page * PAGE_SIZE + items.length;

  const formatTimestamp = (value: string | null) =>
    value ? formatRelativeTime(value) : 'Never';

  return (
    <Page breadcrumbs={['Collisions']}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">Collisions</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            Showing {rangeStart}-{rangeEnd} of {data.total} items
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
                      setCandidateTrackerFilter('all');
                      setCurrentTrackerFilter('all');
                    }}
                    disabled={
                      candidateTrackerFilter === 'all' &&
                      currentTrackerFilter === 'all'
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
              value={candidateTrackerFilter}
              onValueChange={setCandidateTrackerFilter}
            >
              <SelectTrigger size="sm" className="min-w-[200px]">
                <SelectValue placeholder="Candidate tracker" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All candidate trackers</SelectItem>
                {filterOptions.candidateTrackers.map((tracker) => (
                  <SelectItem key={tracker} value={tracker}>
                    {tracker}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={currentTrackerFilter}
              onValueChange={setCurrentTrackerFilter}
            >
              <SelectTrigger size="sm" className="min-w-[200px]">
                <SelectValue placeholder="Current tracker" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All current trackers</SelectItem>
                {filterOptions.currentTrackers.map((tracker) => (
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
              {showClient ? 'Hide torrent client' : 'Show torrent client'}
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
              <TableHead>Conflicting Info Hash</TableHead>
              <TableHead>Candidate Tracker</TableHead>
              <TableHead>Current Tracker</TableHead>
              <TableHead>First Seen</TableHead>
              <TableHead>Last Seen</TableHead>
              {showClient && <TableHead>Client</TableHead>}
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
                      No collisions found.
                    </span>
                    <span className="text-muted-foreground text-xs">
                      Collisions appear when info hashes match across trackers.
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.name}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.infoHash ?? 'Unknown'}
                  </TableCell>
                  <TableCell>
                    {item.candidateTrackers.length
                      ? item.candidateTrackers.join(', ')
                      : 'Unknown'}
                  </TableCell>
                  <TableCell>
                    {item.knownTrackers && item.knownTrackers.length
                      ? item.knownTrackers.join(', ')
                      : 'Unknown'}
                  </TableCell>
                  <TableCell>{formatTimestamp(item.firstSeenAt)}</TableCell>
                  <TableCell>{formatTimestamp(item.lastSeenAt)}</TableCell>
                  {showClient && (
                    <TableCell>
                      {item.clientDisplay && item.clientDisplay.length
                        ? item.clientDisplay.join(', ')
                        : 'Unknown'}
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
